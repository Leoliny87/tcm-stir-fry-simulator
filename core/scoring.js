/**
 * 计分引擎：一票否决 + 倒扣分
 * 与 UI 完全解耦，纯数据层
 */
class _ScoringEngine {
  constructor() {
    this.score = 100
    this.logs = []
    this.oneStrikeOut = false
    this._finalized = false
  }

  deduct(item, reason, points) {
    if (this._finalized) return
    this.score += points
    this.logs.push({ item, reason, points, timestamp: Date.now() })
    EventBus.emit('SCORING_UPDATE', this.snapshot())
  }

  failSafe(reason) {
    if (this._finalized) return
    this.score = 0
    this.oneStrikeOut = true
    this._finalized = true
    this.logs.push({ item: '安全红线', reason, points: -100, timestamp: Date.now() })
    EventBus.emit('SCORING_UPDATE', this.snapshot())
    EventBus.emit('FAIL_SAFE', { reason })
  }

  snapshot() {
    return { score: this.score, logs: [...this.logs], oneStrikeOut: this.oneStrikeOut }
  }

  result() {
    return {
      score: Math.max(0, this.score),
      logs: this.logs,
      oneStrikeOut: this.oneStrikeOut,
      pass: this.score >= 60 && !this.oneStrikeOut
    }
  }
}

var ScoringEngine = _ScoringEngine
window.ScoringEngine = _ScoringEngine
