import { Component } from 'react'

// Ловит в т.ч. сбой загрузки lazy-чанка на плохой сети.
export default class CrmBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="crm-boot">
          <p>Не удалось загрузить CRM.</p>
          <button onClick={() => window.location.reload()}>Обновить страницу</button>
        </div>
      )
    }
    return this.props.children
  }
}
