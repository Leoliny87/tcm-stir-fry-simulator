/**
 * 仿真引擎核心：状态机 + 温度模型 + QTE 判定
 *
 * 状态流转：
 * INIT → PARAM → HEATING → QTE → COOKING → COOLING → END
 * 异常：HEATING → EMERGENCY → END
 */
const STATES = {
  INIT:       'INIT',       // 初始：GMP 未完成
  PARAM:      'PARAM',      // 参数设定
  HEATING:    'HEATING',    // 升温中
  QTE:        'QTE',        // 投药窗口期
  COOKING:    'COOKING',    // 炮制中
  COOLING:    'COOLING',    // 自然降温
  END:        'END',        // 流程结束
  EMERGENCY:  'EMERGENCY',  // 紧急状态（故障）
}

class _Engine {
  constructor() {
    this.state = STATES.INIT
    this.temp = 25           // 当前温度
    this.targetTemp = 0      // 目标温度
    this.speed = 0           // 当前转速
    this.targetSpeed = 0     // 目标转速
    this.time = 0            // 仿真秒数
    this.running = false

    // QTE 相关
    this.qteActive = false
    this.qteStart = 0
    this.qteDuration = 5000  // 5 秒窗口
    this.feedDone = false
    this.feedTemp = 0

    // 异常处理
    this.faultActive = false
    this.faultType = null
    this.estopWindow = 3     // 3 秒急停窗口

    // 温度模型
    this.heatingRate = 5.0   // 升温速率 ℃/s
    this.maxTemp = 0

    // 计时器
    this._simTimer = null
    this._qteTimer = null
    this._estopTimer = null
    this._qteInterval = null
    this._faultTimer = null

    // 评分
    this.scoring = new ScoringEngine()
  }

  // ============ 状态跳转 ============

  setState(newState) {
    const old = this.state
    this.state = newState
    EventBus.emit('STATE_CHANGE', { from: old, to: newState })
  }

  // ============ 阶段1：GMP 完成 → 进入参数设定 ============

  completeGmp() {
    if (this.state !== STATES.INIT) return
    this.setState(STATES.PARAM)
    EventBus.emit('UI_UNLOCK', true)
  }

  skipGmp() {
    if (this.state !== STATES.INIT) return
    this.scoring.deduct('GMP', '跳过安全确认', -5)
    this.completeGmp()
  }

  // ============ 阶段2：参数设定 ============

  setParams(targetTemp, targetSpeed) {
    this.targetTemp = targetTemp
    this.targetSpeed = targetSpeed
    EventBus.emit('PARAMS_SET', { targetTemp, targetSpeed })
  }

  // ============ 阶段3：启动加热 ============

  startHeating() {
    if (this.state !== STATES.PARAM && this.state !== STATES.INIT) return
    if (this.targetTemp === 0 || this.targetSpeed === 0) {
      EventBus.emit('PARAM_ERROR', { reason: '参数未设置' })
      return
    }

    this.setState(STATES.HEATING)
    this.running = true
    this.temp = 25
    this.time = 0
    this.maxTemp = 25
    this.feedDone = false
    this.qteActive = false

    EventBus.emit('DRUM_START')

    // 主模拟循环：100ms 步进
    this._lastTick = Date.now()
    this._simLoop()
  }

  _simLoop() {
    if (!this.running) return

    const now = Date.now()
    const dt = Math.min((now - this._lastTick) / 1000, 0.1)
    this._lastTick = now
    this.time += dt

    // 升温模型：指数逼近目标温度
    if (this.temp < this.targetTemp) {
      this.temp = Math.min(this.targetTemp, this.temp + this.heatingRate * dt)
    } else {
      this.temp = this.targetTemp + Math.sin(this.time * 0.5) * 2
    }

    // 记录最高温度
    if (this.temp > this.maxTemp) this.maxTemp = this.temp

    // 转速逼近
    if (this.speed < this.targetSpeed) {
      this.speed = Math.min(this.targetSpeed, this.speed + 2 * dt)
    }

    // 检查 QTE 触发
    this._checkQteTrigger()

    // 检查错过投药时机
    if (!this.feedDone && this.temp > 220) {
      this.scoring.deduct('投药', '温度超过220℃仍未投药', -10)
      EventBus.emit('FEED_MISSED', { reason: 'overtemp' })
    }

    // 广播
    EventBus.emit('TEMP_UPDATE', {
      temp: Math.round(this.temp * 10) / 10,
      speed: Math.round(this.speed * 10) / 10,
      time: Math.round(this.time * 10) / 10,
      maxTemp: Math.round(this.maxTemp * 10) / 10,
    })

    if (this.running) {
      this._simTimer = requestAnimationFrame(() => this._simLoop())
    }
  }

  // ============ QTE 投药窗口 ============

  _checkQteTrigger() {
    if (this.feedDone || this.qteActive) return
    if (this.temp >= 180 && this.temp <= 220) {
      this.qteActive = true
      this.qteStart = Date.now()

      EventBus.emit('QTE_START', { temp: this.temp, time: this.time })

      // QTE 倒计时可视化
      const qteInterval = setInterval(() => {
        const elapsed = Date.now() - this.qteStart
        const remaining = Math.max(0, 1 - elapsed / this.qteDuration)
        EventBus.emit('QTE_COUNTDOWN', {
          remaining: remaining,
          seconds: Math.max(0, (this.qteDuration - elapsed) / 1000),
        })
      }, 100)

      // 超时处理
      this._qteTimer = setTimeout(() => {
        clearInterval(qteInterval)
        if (this.qteActive && !this.feedDone && this.running) {
          this.scoring.deduct('投药', '5秒窗口期超时', -10)
          this.qteActive = false
          EventBus.emit('QTE_TIMEOUT')
        }
      }, this.qteDuration)
    }
  }

  // ============ 投药 ============

  feed() {
    // 提前投药
    if (!this.qteActive && this.temp < 180) {
      this.scoring.deduct('投药', '火候未到（<' + Math.round(this.temp) + '℃）', -15)
      EventBus.emit('FEED_EARLY', { temp: this.temp })
      return
    }

    // 过热投药
    if (!this.qteActive && this.temp > 220) {
      this.scoring.deduct('投药', '火候已过（>' + Math.round(this.temp) + '℃）', -15)
      EventBus.emit('FEED_LATE', { temp: this.temp })
      return
    }

    // QTE 窗口期内投药
    this.feedDone = true
    this.feedTemp = this.temp
    this.qteActive = false

    if (this._qteTimer) clearTimeout(this._qteTimer)

    // 判断火候质量
    const delta = Date.now() - this.qteStart
    if (this.temp >= 180 && this.temp <= 220) {
      if (this.temp >= 190 && this.temp <= 210 && delta <= 3000) {
        EventBus.emit('FEED_PERFECT', { temp: this.temp, delay: delta })
      } else {
        EventBus.emit('FEED_NORMAL', { temp: this.temp, delay: delta })
      }
    }

    EventBus.emit('FEED_SUCCESS', { temp: this.temp, delay: delta })
    this.setState(STATES.COOKING)

    // 30% 概率触发故障
    if (Math.random() < 0.3) {
      this._scheduleFault()
    }

    // 炮制持续10秒后进入降温
    setTimeout(() => {
      if (this.running && this.state === STATES.COOKING) {
        this.stopHeating()
        this.startCooling()
      }
    }, 10000)
  }

  // ============ 故障模拟 ============

  _scheduleFault() {
    this._faultTimer = setTimeout(() => {
      if (!this.running || this.faultActive) return
      this._triggerFault()
    }, 3000 + Math.random() * 5000)
  }

  _triggerFault() {
    this.faultActive = true
    const faults = [
      { type: 'coil_overheat', text: '线圈过热报警！' },
      { type: 'motor_overload', text: '滚筒电机过载！' },
    ]
    const fault = faults[Math.floor(Math.random() * 2)]
    this.faultType = fault.type

    this.setState(STATES.EMERGENCY)
    EventBus.emit('FAULT_TRIGGER', fault)

    // 3 秒急停窗口
    let countdown = 3
    EventBus.emit('ESTOP_COUNTDOWN', { countdown })

    this._estopTimer = setInterval(() => {
      countdown--
      EventBus.emit('ESTOP_COUNTDOWN', { countdown: Math.max(0, countdown) })
      if (countdown <= 0) {
        clearInterval(this._estopTimer)
        if (this.faultActive && this.running) {
          this.scoring.failSafe('故障3秒内未拍急停')
          this._shutdown()
          EventBus.emit('GAME_OVER')
        }
      }
    }, 1000)
  }

  // ============ 紧急停止 ============

  emergencyStop() {
    if (this.faultActive) {
      // 正确响应故障急停
      this.faultActive = false
      if (this._estopTimer) clearInterval(this._estopTimer)
      this.scoring.deduct('应急', '故障急停（扣1分）', -1)
      this._shutdown()
      EventBus.emit('ESTOP_SUCCESS')
      return
    }
    // 非故障状态急停
    this._shutdown()
    EventBus.emit('MANUAL_STOP')
  }

  _shutdown() {
    this.running = false
    if (this._simTimer) cancelAnimationFrame(this._simTimer)
    if (this._qteTimer) clearTimeout(this._qteTimer)
    if (this._estopTimer) clearInterval(this._estopTimer)
    if (this._faultTimer) clearTimeout(this._faultTimer)
    if (this._qteInterval) clearInterval(this._qteInterval)
    this.speed = 0
    this.temp = 25
    this.faultActive = false
  }

  // ============ 降温 ============

  startCooling() {
    this.running = true
    this.setState(STATES.COOLING)
    this.temp = this.maxTemp
    this.speed = this.targetSpeed

    const coolStart = Date.now()
    const coolStartTemp = this.temp

    const coolLoop = () => {
      if (this.state !== STATES.COOLING) return
      const elapsed = (Date.now() - coolStart) / 1000
      this.temp = 25 + (coolStartTemp - 25) * Math.exp(-0.05 * elapsed)
      this.speed = Math.max(0, this.targetSpeed * Math.exp(-0.03 * elapsed))

      EventBus.emit('TEMP_UPDATE', {
        temp: Math.round(this.temp * 10) / 10,
        speed: Math.round(this.speed * 10) / 10,
        time: Math.round(this.time * 10) / 10,
        maxTemp: Math.round(this.maxTemp * 10) / 10,
      })

      if (this.temp > 40) {
        this._simTimer = requestAnimationFrame(coolLoop)
      } else {
        this.temp = 25
        this.speed = 0
        this.running = false
        this.setState(STATES.END)
        EventBus.emit('COOLING_COMPLETE')
      }
    }
    this._simTimer = requestAnimationFrame(coolLoop)
  }

  // ============ 报告 ============

  getReport() {
    return {
      state: this.state,
      params: { targetTemp: this.targetTemp, targetSpeed: this.targetSpeed },
      results: {
        maxTemp: Math.round(this.maxTemp * 10) / 10,
        feedTemp: Math.round(this.feedTemp * 10) / 10,
        feedDone: this.feedDone,
        totalTime: Math.round(this.time * 10) / 10,
      },
      scoring: this.scoring.result(),
    }
  }
}

var Engine = new _Engine()
window.Engine = Engine
