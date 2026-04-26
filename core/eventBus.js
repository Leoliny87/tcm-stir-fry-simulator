/**
 * 事件总线：解耦引擎与 UI 层
 * 所有状态变更通过 EventBus 广播，UI 层监听响应
 */
class _EventBus {
  constructor() {
    this.events = {}
  }

  on(event, cb) {
    if (!this.events[event]) this.events[event] = []
    this.events[event].push(cb)
  }

  off(event, cb) {
    if (!this.events[event]) return
    this.events[event] = this.events[event].filter(c => c !== cb)
  }

  emit(event, data) {
    (this.events[event] || []).forEach(cb => {
      try { cb(data) } catch (e) { console.error('[EventBus]', event, e) }
    })
  }
}

var EventBus = new _EventBus()
window.EventBus = EventBus
