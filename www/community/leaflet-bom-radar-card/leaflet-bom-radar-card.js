// leaflet-bom-radar-card.js
// Version 2.0.0 - Dynamic Multi-Radar Support

class LeafletBomRadarCard extends HTMLElement {
  constructor() {
    super();
    this.imageCache = new Map();
    this.radarTimestamps = new Map();
    this.activeOverlays = new Map();
    this.visibleRadars = new Set();
    this.allTimestamps = [];
    this.currentFrameIndex = 0;
    this.isPlaying = false;
    this.playbackInterval = null;
    this.map = null;
    this.radarLocations = null;
    this.lastTimestampFetch = new Map();
    this.MIN_FETCH_INTERVAL = 600000; // 10 minutes
    this.ingressUrl = null;
    this.updateViewportDebounce = null;
  }

  setConfig(config) {
    this.config = {
      cache_hours: config.cache_hours || 2,
      playback_speed: config.playback_speed || 500,
      default_zoom: config.default_zoom || 8,
      opacity: config.opacity || 0.7,
      base_layer: config.base_layer || 'osm',
      show_legend: config.show_legend !== false,
      fade_duration: config.fade_duration || 300,
      max_radar_distance_km: config.max_radar_distance_km || 800,
    };
  }

  async set hass(hass) {
    this._hass = hass;
    
    if (!this.content) {
      await this.getIngressUrl();
      
      if (!this.radarLocations) {
        await this.loadRadarData();
      }
      
      this.render();
      await this.setupMap();
      await this.initializeViewport();
    }
  }

  async getIngressUrl() {
    try {
      this.ingressUrl = '/api/hassio_ingress/' + await this.getIngressToken();
      console.log('Using ingress URL:', this.ingressUrl);
    } catch (error) {
      console.error('Failed to get ingress URL:', error);
      this.ingressUrl = this.detectIngressUrl();
    }
  }

  async getIngressToken() {
    try {
      const response = await fetch('/api/hassio/ingress/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          addon: 'local_bom_radar_proxy'
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.data.session;
      }
    } catch (error) {
      console.error('Error getting ingress token:', error);
    }
    
    return 'bom_radar_proxy';
  }

  detectIngressUrl() {
    const path = window.location.pathname;
    const match = path.match(/\/api\/hassio_ingress\/([^\/]+)/);
    
    if (match) {
      return `/api/hassio_ingress/${match[1]}`;
    }
    
    return '/api/hassio_ingress/bom_radar_proxy';
  }

  async apiRequest(endpoint) {
    const url = `${this.ingressUrl}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response;
  }

  async loadRadarData() {
    try {
      const response = await this.apiRequest('/api/radars');
      const data = await response.json();
      
      this.radarLocations = {};
      data.features.forEach(feature => {
        const id = feature.properties.id;
        this.radarLocations[id] = {
          id: id,
          name: feature.properties.name,
          state: feature.properties.state,
          type: feature.properties.type,
          lat: feature.geometry.coordinates[1],
          lon: feature.geometry.coordinates[0]
        };
      });
      
      console.log(`Loaded ${Object.keys(this.radarLocations).length} radar locations`);
    } catch (error) {
      console.error('Failed to load radar data:', error);
      this.showError('Failed to load radar locations. Check add-on is running.');
      
      // Fallback
      this.radarLocations = {
        'IDR023': { 
          id: 'IDR023',
          name: 'Melbourne', 
          lat: -37.855222, 
          lon: 144.755417, 
          state: 'VIC', 
          type: 'High-resolution Doppler' 
        }
      };
    }
  }

  render() {
    if (!this.content) {
      this.innerHTML = `
        <ha-card>
          <div class="card-header">
            <div class="name">Australian Weather Radar</div>
            <div class="radar-info" id="radar-info">Loading...</div>
          </div>
          <div class="card-content">
            <div id="map-container">
              <div id="radar-map"></div>
              ${this.config.show_legend ? this.renderLegend() : ''}
              <div id="loading-overlay" class="loading-overlay" style="display: none;">
                <div class="loading-spinner"></div>
                <div class="loading-text">Loading radar data...</div>
              </div>
            </div>
            <div class="controls-container">
              ${this.renderControls()}
            </div>
            <div class="status-bar">
              <span id="timestamp-display">Initializing...</span>
              <span id="status-info"></span>
            </div>
          </div>
          <div id="error-message" class="error-message" style="display: none;"></div>
        </ha-card>
        <style>
          ${this.getStyles()}
        </style>
      `;
      this.content = this.querySelector('.card-content');
    }
  }

  renderLegend() {
    return `
      <div class="radar-legend">
        <div class="legend-title">Rainfall Rate</div>
        <div class="legend-items">
          <div class="legend-item"><span class="legend-color" style="background: #00ECEC;"></span>Light</div>
          <div class="legend-item"><span class="legend-color" style="background: #01A0F6;"></span>Moderate</div>
          <div class="legend-item"><span class="legend-color" style="background: #0000F6;"></span>Heavy</div>
          <div class="legend-item"><span class="legend-color" style="background: #00FF00;"></span>Very Heavy</div>
          <div class="legend-item"><span class="legend-color" style="background: #FFFF00;"></span>Intense</div>
          <div class="legend-item"><span class="legend-color" style="background: #FF0000;"></span>Extreme</div>
        </div>
      </div>
    `;
  }

  renderControls() {
    return `
      <div class="radar-controls">
        <div class="playback-controls">
          <button id="play-btn" class="control-btn" title="Play animation">▶</button>
          <button id="pause-btn" class="control-btn" title="Pause animation" style="display: none;">⏸</button>
          <button id="prev-btn" class="control-btn" title="Previous frame">⏮</button>
          <button id="next-btn" class="control-btn" title="Next frame">⏭</button>
          <button id="refresh-btn" class="control-btn" title="Refresh radar data">🔄</button>
        </div>
        <div class="timeline-container">
          <input type="range" 
                 id="timeline-slider" 
                 min="0" 
                 max="100" 
                 value="0"
                 class="timeline-slider"
                 title="Scrub through radar images">
          <div id="timeline-labels" class="timeline-labels"></div>
        </div>
        <div class="zoom-controls">
          <label>Zoom:</label>
          <button id="zoom-in" class="control-btn" title="Zoom in">+</button>
          <button id="zoom-out" class="control-btn" title="Zoom out">−</button>
          <button id="zoom-home" class="control-btn" title="Reset to home location">⌂</button>
        </div>
      </div>
    `;
  }

  getStyles() {
    return `
      ha-card {
        overflow: hidden;
      }
      .card-header {
        padding: 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .name {
        font-size: 24px;
        font-weight: 500;
      }
      .radar-info {
        font-size: 14px;
        color: var(--secondary-text-color);
      }
      .card-content {
        padding: 0;
      }
      #map-container {
        position: relative;
        height: 500px;
        width: 100%;
      }
      #radar-map {
        height: 100%;
        width: 100%;
      }
      .loading-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 2000;
      }
      .loading-spinner {
        border: 4px solid rgba(255, 255, 255, 0.3);
        border-top: 4px solid var(--primary-color);
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .loading-text {
        color: white;
        margin-top: 16px;
        font-size: 16px;
      }
      .radar-legend {
        position: absolute;
        bottom: 40px;
        right: 10px;
        background: rgba(255, 255, 255, 0.95);
        padding: 12px;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        z-index: 1000;
        font-size: 12px;
        backdrop-filter: blur(4px);
      }
      .legend-title {
        font-weight: bold;
        margin-bottom: 8px;
        font-size: 13px;
      }
      .legend-items {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .legend-item {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .legend-color {
        width: 24px;
        height: 14px;
        border: 1px solid #ccc;
        border-radius: 2px;
      }
      .controls-container {
        padding: 16px;
        background: var(--card-background-color);
        border-top: 1px solid var(--divider-color);
      }
      .radar-controls {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .playback-controls {
        display: flex;
        gap: 8px;
        justify-content: center;
        flex-wrap: wrap;
      }
      .control-btn {
        background: var(--primary-color);
        color: var(--text-primary-color);
        border: none;
        border-radius: 4px;
        padding: 10px 18px;
        cursor: pointer;
        font-size: 16px;
        transition: all 0.2s;
        min-width: 44px;
        min-height: 44px;
      }
      .control-btn:hover {
        background: var(--primary-color-dark, var(--primary-color));
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .control-btn:active {
        transform: translateY(0);
      }
      .control-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .timeline-container {
        width: 100%;
        position: relative;
      }
      .timeline-slider {
        width: 100%;
        height: 8px;
        border-radius: 4px;
        outline: none;
        -webkit-appearance: none;
        background: var(--divider-color);
        cursor: pointer;
      }
      .timeline-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--primary-color);
        cursor: pointer;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .timeline-slider::-moz-range-thumb {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--primary-color);
        cursor: pointer;
        border: none;
        box-
