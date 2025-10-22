// leaflet-bom-radar-card-editor.js

class LeafletBomRadarCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  configChanged(newConfig) {
    const event = new Event('config-changed', {
      bubbles: true,
      composed: true
    });
    event.detail = { config: newConfig };
    this.dispatchEvent(event);
  }

  render() {
    if (!this._config) {
      return;
    }

    this.innerHTML = `
      <style>
        .card-config {
          padding: 16px;
        }
        .option {
          display: flex;
          align-items: center;
          margin-bottom: 16px;
        }
        .option label {
          flex: 1;
          font-weight: 500;
        }
        .option input[type="text"],
        .option input[type="number"],
        .option select {
          flex: 2;
          padding: 8px;
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }
        .option input[type="checkbox"] {
          margin-left: auto;
        }
        .help-text {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-top: 4px;
          margin-left: 0;
        }
        .section-header {
          font-size: 16px;
          font-weight: bold;
          margin: 24px 0 12px 0;
          color: var(--primary-text-color);
        }
      </style>
      <div class="card-config">
        <div class="section-header">Radar Settings</div>
        
        <div class="option">
          <label for="radar_id">Radar ID</label>
          <input
            type="text"
            id="radar_id"
            .value="${this._config.radar_id || 'IDR023'}"
            @change="${this._valueChanged}"
          />
        </div>
        <div class="help-text">
          Radar ID (e.g., IDR023 for Melbourne). Leave empty to auto-select closest radar.
        </div>
        
        <div class="option">
          <label for="auto_select_radar">Auto-select closest radar</label>
          <input
            type="checkbox"
            id="auto_select_radar"
            .checked="${this._config.auto_select_radar !== false}"
            @change="${this._valueChanged}"
          />
        </div>
        
        <div class="section-header">Display Settings</div>
        
        <div class="option">
          <label for="cache_hours">Cache Hours</label>
          <input
            type="number"
            id="cache_hours"
            min="1"
            max="24"
            .value="${this._config.cache_hours || 2}"
            @change="${this._valueChanged}"
          />
        </div>
        <div class="help-text">
          Number of hours of radar history to display (1-24)
        </div>
        
        <div class="option">
          <label for="default_zoom">Default Zoom Level</label>
          <input
            type="number"
            id="default_zoom"
            min="5"
            max="15"
            .value="${this._config.default_zoom || 8}"
            @change="${this._valueChanged}"
          />
        </div>
        
        <div class="option">
          <label for="opacity">Radar Opacity</label>
          <input
            type="number"
            id="opacity"
            min="0"
            max="1"
            step="0.1"
            .value="${this._config.opacity || 0.7}"
            @change="${this._valueChanged}"
          />
        </div>
        
        <div class="option">
          <label for="base_layer">Base Map Layer</label>
          <select id="base_layer" @change="${this._valueChanged}">
            <option value="osm" ${this._config.base_layer === 'osm' ? 'selected' : ''}>
              OpenStreetMap
            </option>
            <option value="google" ${this._config.base_layer === 'google' ? 'selected' : ''}>
              Google Maps
            </option>
          </select>
        </div>
        
        <div class="section-header">Animation Settings</div>
        
        <div class="option">
          <label for="playback_speed">Playback Speed (ms)</label>
          <input
            type="number"
            id="playback_speed"
            min="100"
            max="2000"
            step="100"
            .value="${this._config.playback_speed || 500}"
            @change="${this._valueChanged}"
          />
        </div>
        <div class="help-text">
          Milliseconds between frames during animation (lower = faster)
        </div>
        
        <div class="section-header">Visual Options</div>
        
        <div class="option">
          <label for="show_legend">Show Legend</label>
          <input
            type="checkbox"
            id="show_legend"
            .checked="${this._config.show_legend !== false}"
            @change="${this._valueChanged}"
          />
        </div>
        
        <div class="option">
          <label for="show_home_marker">Show Home Marker</label>
          <input
            type="checkbox"
            id="show_home_marker"
            .checked="${this._config.show_home_marker !== false}"
            @change="${this._valueChanged}"
          />
        </div>
        
        <div class="option">
          <label for="show_radar_marker">Show Radar Marker</label>
          <input
            type="checkbox"
            id="show_radar_marker"
            .checked="${this._config.show_radar_marker !== false}"
            @change="${this._valueChanged}"
          />
        </div>
      </div>
    `;
  }

  _valueChanged(ev) {
    if (!this._config || !this._hass) {
      return;
    }

    const target = ev.target;
    const configValue = target.id;
    let value;

    if (target.type === 'checkbox') {
      value = target.checked;
    } else if (target.type === 'number') {
      value = parseFloat(target.value);
    } else {
      value = target.value;
    }

    if (this._config[configValue] === value) {
      return;
    }

    const newConfig = {
      ...this._config,
      [configValue]: value
    };

    this.configChanged(newConfig);
  }
}

customElements.define("leaflet-bom-radar-card-editor", LeafletBomRadarCardEditor);
