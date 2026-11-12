class NativeStatusCard extends HTMLElement {
  async connectedCallback() {
    this.style.cssText = 'display:block;font:16px system-ui;background:#071827;color:#e8f3ff;min-height:100vh;padding:32px;box-sizing:border-box';
    this.textContent = 'Brokered NativeKit response loading…';
    try {
      const [app, network] = await Promise.all([NativeKit.app.info(), NativeKit.network.status()]);
      this.innerHTML = '';
      const title = document.createElement('h2');
      title.textContent = this.getAttribute('heading') || 'Device status';
      const output = document.createElement('pre');
      output.textContent = JSON.stringify({ app, network, identity: NativeKit.appIdentity }, null, 2);
      this.append(title, output);
    } catch (error) {
      this.textContent = `Policy denied or unavailable: ${error.message}`;
    }
  }
}
customElements.define('native-status-card', NativeStatusCard);
