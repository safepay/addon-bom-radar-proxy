// leaflet-bom-radar-card.js
// Version 1.0.0

class LeafletBomRadarCard extends HTMLElement {
  constructor() {
    super();
    this.imageCache = new Map();
    this.timestamps = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.playbackInterval = null;
    this.currentOverlay = null;
    this.map = null;
    this.radarLocations = null;
    this.lastTimestampFetch = 0;
    this.MIN_FETCH_INTERVAL = 600000; // 10 minutes
    this.ingressUrl = null;
  }

  setConfig(config) {
    this.config = {
      radar_id: config.radar_id || 'IDR023', // Default to Melbourne
      cache_hours: config.cache_hours || 2,
      playback_speed: config.playback_speed || 500,
      default_zoom: config.default_zoom || 8,
      opacity: config.opacity || 0.7,
      base_layer: config.base_layer || 'osm',
      auto_select_radar: config.auto_select_radar !== false,
      show_legend: config.show_legend !== false,
      show_home_marker: config.show_home_marker !== false,
      show_radar_marker: config.show_radar_marker !== false,
    };
  }

  async set hass(hass) {
    this._hass = hass;
    
    if (!this.content) {
      // Get ingress URL for add-on
      await this.getIngressUrl();
      
      // Load radar data
      if (!this.radarLocations) {
        await this.loadRadarData();
      }
      
      // Auto-select closest radar if enabled
      if (this.config.auto_select_radar && this._hass.config.latitude && this._hass.config.longitude) {
        await this.selectClosestRadar();
      }
      
      // Validate radar_id
      if (!this.radarLocations[this.config.radar_id]) {
        console.error(`Unknown radar_id: ${this.config.radar_id}`);
        this.config.radar_id = 'IDR023'; // Fallback to Melbourne
      }
      
      this.render();
      await this.setupMap();
      await this.initializeCache();
    }
  }

  /**
   * Get the ingress URL for the add-on
   */
  async getIngressUrl() {
    try {
      // Try to get ingress URL from Home Assistant
      // The ingress URL format is: /api/hassio_ingress/<token>
      // We'll use relative URLs which will work through ingress
      this.ingressUrl = '/api/hassio_ingress/' + await this.getIngressToken();
      console.log('Using ingress URL:', this.ingressUrl);
    } catch (error) {
      console.error('Failed to get ingress URL:', error);
      // Fallback: try to detect from current URL or use supervisor API
      this.ingressUrl = this.detectIngressUrl();
    }
  }

  /**
   * Get ingress token from supervisor
   */
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
    
    // Fallback: construct ingress path
    return 'bom_radar_proxy';
  }

  /**
   * Detect ingress URL from browser location
   */
  detectIngressUrl() {
    // Check if we're already in an ingress context
    const path = window.location.pathname;
    const match = path.match(/\/api\/hassio_ingress\/([^\/]+)/);
    
    if (match) {
      return `/api/hassio_ingress/${match[1]}`;
    }
    
    // Default fallback
    return '/api/hassio_ingress/bom_radar_proxy';
  }

  /**
   * Make API request through ingress
   */
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
      
      // Convert GeoJSON to radar locations object
      this.radarLocations = {};
      data.features.forEach(feature => {
        const id = feature.properties.id;
        this.radarLocations[id] = {
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
      
      // Fallback to Melbourne only
      this.radarLocations = {
        'IDR023': { 
          name: 'Melbourne', 
          lat: -37.855222, 
          lon: 144.755417, 
          state: 'VIC', 
          type: 'High-resolution Doppler' 
        }
      };
    }
  }

  async selectClosestRadar() {
    try {
      const lat = this._hass.config.latitude;
      const lon = this._hass.config.longitude;
      
      const response = await this.apiRequest(`/api/closest-radar?lat=${lat}&lon=${lon}`);
      const closest = await response.json();
      
      if (closest && closest.id) {
        console.log(`Auto-selected closest radar: ${closest.name} (${closest.distance}km away)`);
        this.config.radar_id = closest.id;
      }
    } catch (error) {
      console.error('Failed to auto-select radar:', error);
    }
  }

  render() {
    if (!this.content) {
      const radarInfo = this.radarLocations[this.config.radar_id];
      
      this.innerHTML = `
        <ha-card>
          <div class="card-header">
            <div class="header-content">
              <div class="name">${radarInfo.name} Weather Radar</div>
              <div class="radar-selector">
                <select id="radar-select" class="radar-select" title="Select radar location">
                  ${Object.entries(this.radarLocations)
                    .sort((a, b) => a[1].name.localeCompare(b[1].name))
                    .map(([id, radar]) => `
                      <option value="${id}" ${id === this.config.radar_id ? 'selected' : ''}>
                        ${radar.name} (${radar.state})
                      </option>
                    `).join('')}
                </select>
              </div>
            </div>
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
              <span id="timestamp-display">Loading...</span>
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
          <select id="zoom-preset" class="zoom-select" title="Quick zoom presets">
            <option value="7">Wide (512km)</option>
            <option value="8" selected>Medium (256km)</option>
            <option value="9">Close (128km)</option>
            <option value="11">Very Close (64km)</option>
          </select>
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
      }
      .header-content {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .name {
        font-size: 24px;
        font-weight: 500;
        flex: 1;
        min-width: 200px;
      }
      .radar-selector {
        flex-shrink: 0;
      }
      .radar-select {
        padding: 8px 12px;
        border-radius: 4px;
        border: 1px solid var(--divider-color);
        background: var(--card-background-color);
        color: var(--primary-text-color);
        font-size: 14px;
        cursor: pointer;
        min-width: 200px;
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
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .timeline-labels {
        display: flex;
        justify-content: space-between;
        margin-top: 4px;
        font-size: 10px;
        color: var(--secondary-text-color);
      }
      .zoom-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
      }
      .zoom-controls label {
        font-weight: 500;
      }
      .zoom-select {
        padding: 8px 12px;
        border-radius: 4px;
        border: 1px solid var(--divider-color);
        background: var(--card-background-color);
        color: var(--primary-text-color);
        cursor: pointer;
      }
      .status-bar {
        padding: 12px 16px;
        background: var(--secondary-background-color);
        border-top: 1px solid var(--divider-color);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 13px;
        color: var(--secondary-text-color);
        flex-wrap: wrap;
        gap: 8px;
      }
      #timestamp-display {
        font-weight: 500;
        color: var(--primary-text-color);
      }
      .error-message {
        padding: 16px;
        background: var(--error-color, #f44336);
        color: white;
        text-align: center;
      }
      .leaflet-container {
        background: #a0d6f5 !important;
        font-family: inherit;
      }
      
      /* Responsive design */
      @media (max-width: 600px) {
        .header-content {
          flex-direction: column;
          align-items: stretch;
        }
        .radar-selector {
          width: 100%;
        }
        .radar-select {
          width: 100%;
        }
        #map-container {
          height: 400px;
        }
        .playback-controls {
          justify-content: space-between;
        }
        .control-btn {
          flex: 1;
          min-width: auto;
        }
        .zoom-controls {
          justify-content: space-between;
        }
        .radar-legend {
          font-size: 10px;
          padding: 8px;
          bottom: 30px;
          right: 5px;
        }
        .legend-color {
          width: 20px;
          height: 12px;
        }
      }
    `;
  }

  async setupMap() {
    // Load Leaflet if not already loaded
    await this.loadLeaflet();
    
    // Get user's home location from Home Assistant
    const latitude = this._hass.config.latitude || -37.855222; // Fallback to Melbourne

    // Initialize map centered on user's location
    const radarLoc = this.radarLocations[this.config.radar_id];
    
    this.map = L.map(this.querySelector('#radar-map'), {
      zoomControl: false,
      attributionControl: true
    }).setView([latitude, longitude], this.config.default_zoom);
    
    // Add zoom control to top right
    L.control.zoom({
      position: 'topright'
    }).addTo(this.map);
    
    // Add base layer
    this.addBaseLayer();
    
    // Add markers
    if (this.config.show_home_marker) {
      this.addHomeMarker(latitude, longitude);
    }
    
    if (this.config.show_radar_marker) {
      this.addRadarMarker(radarLoc);
    }
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Monitor zoom changes
    this.map.on('zoomend', () => {
      this.updateStatusInfo();
    });
    
    this.map.on('moveend', () => {
      this.updateStatusInfo();
    });
  }

  async loadLeaflet() {
    if (window.L) return;
    
    return new Promise((resolve, reject) => {
      // Load Leaflet CSS
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
      link.crossOrigin = '';
      document.head.appendChild(link);
      
      // Load Leaflet JS
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
      script.crossOrigin = '';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  addBaseLayer() {
    if (this.config.base_layer === 'google') {
      L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        attribution: '© Google Maps',
        maxZoom: 20
      }).addTo(this.map);
    } else {
      // OpenStreetMap (default)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
      }).addTo(this.map);
    }
  }

  addHomeMarker(lat, lon) {
    const homeIcon = L.divIcon({
      html: '<div style="font-size: 24px;">🏠</div>',
      className: 'home-marker',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    
    L.marker([lat, lon], { icon: homeIcon })
      .addTo(this.map)
      .bindPopup('<b>Home</b>');
  }

  addRadarMarker(radarLoc) {
    const radarIcon = L.divIcon({
      html: '<div style="font-size: 24px;">📡</div>',
      className: 'radar-marker',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    
    L.marker([radarLoc.lat, radarLoc.lon], { icon: radarIcon })
      .addTo(this.map)
      .bindPopup(`<b>${radarLoc.name}</b><br>${radarLoc.type}`);
  }

  setupEventListeners() {
    // Radar selector
    this.querySelector('#radar-select').addEventListener('change', (e) => {
      this.handleRadarChange(e.target.value);
    });
    
    // Play button
    this.querySelector('#play-btn').addEventListener('click', () => this.play());
    
    // Pause button
    this.querySelector('#pause-btn').addEventListener('click', () => this.pause());
    
    // Previous button
    this.querySelector('#prev-btn').addEventListener('click', () => this.previousFrame());
    
    // Next button
    this.querySelector('#next-btn').addEventListener('click', () => this.nextFrame());
    
    // Refresh button
    this.querySelector('#refresh-btn').addEventListener('click', () => this.refreshRadarData());
    
    // Timeline slider
    this.querySelector('#timeline-slider').addEventListener('input', (e) => {
      this.goToFrame(parseInt(e.target.value));
    });
    
    // Zoom controls
    this.querySelector('#zoom-in').addEventListener('click', () => {
      this.map.zoomIn();
    });
    
    this.querySelector('#zoom-out').addEventListener('click', () => {
      this.map.zoomOut();
    });
    
    this.querySelector('#zoom-home').addEventListener('click', () => {
      const homeLat = this._hass.config.latitude || -37.855222;
      const homeLon = this._hass.config.longitude || 144.755417;
      this.map.setView([homeLat, homeLon], this.config.default_zoom);
    });
    
    this.querySelector('#zoom-preset').addEventListener('change', (e) => {
      this.map.setZoom(parseInt(e.target.value));
    });
  }

  async handleRadarChange(newRadarId) {
    this.config.radar_id = newRadarId;
    const radarLoc = this.radarLocations[newRadarId];
    
    // Update header
    this.querySelector('.name').textContent = `${radarLoc.name} Weather Radar`;
    
    // Pan to new radar
    this.map.setView([radarLoc.lat, radarLoc.lon], this.config.default_zoom);
    
    // Clear existing data
    this.timestamps = [];
    this.currentIndex = 0;
    this.imageCache.clear();
    
    if (this.currentOverlay) {
      this.map.removeLayer(this.currentOverlay);
      this.currentOverlay = null;
    }
    
    // Load new radar data
    this.showLoading(true);
    await this.initializeCache();
    this.showLoading(false);
  }

  async initializeCache() {
    try {
      this.updateStatusDisplay('Fetching radar timestamps...');
      
      // Fetch available timestamps
      await this.fetchTimestamps();
      
      if (this.timestamps.length === 0) {
        this.updateStatusDisplay('No radar images available');
        return;
      }
      
      // Start with most recent image
      this.currentIndex = this.timestamps.length - 1;
      
      // Display current frame
      await this.updateRadarDisplay();
      this.updateTimeline();
      this.updateTimelineLabels();
      
      this.updateStatusDisplay(`Loaded ${this.timestamps.length} radar images`);
    } catch (error) {
      console.error('Failed to initialize cache:', error);
      this.showError('Failed to load radar data: ' + error.message);
    }
  }

  async fetchTimestamps(force = false) {
    try {
      const now = Date.now();
      
      // Check if we need to wait before fetching (10 minute minimum)
      if (!force && (now - this.lastTimestampFetch) < this.MIN_FETCH_INTERVAL) {
        const waitTime = Math.ceil((this.MIN_FETCH_INTERVAL - (now - this.lastTimestampFetch)) / 1000);
        console.log(`Timestamp refresh rate limited, ${waitTime}s remaining`);
        return;
      }
      
      const limit = Math.ceil((this.config.cache_hours * 60) / 10); // Approximately 10 min intervals
      const response = await this.apiRequest(`/api/timestamps/${this.config.radar_id}?limit=${limit}`);
      const data = await response.json();
      
      this.timestamps = data.timestamps || [];
      this.lastTimestampFetch = now;
      
      console.log(`Fetched ${this.timestamps.length} timestamps for ${this.config.radar_id}`);
      
      if (data.nextRefreshIn) {
        this.updateStatusInfo(`Next refresh in ${Math.ceil(data.nextRefreshIn / 60)}min`);
      }
    } catch (error) {
      console.error('Failed to fetch timestamps:', error);
      throw error;
    }
  }

  async refreshRadarData() {
    const refreshBtn = this.querySelector('#refresh-btn');
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳';
    
    this.showLoading(true);
    
    try {
      // Force refresh timestamps
      await this.fetchTimestamps(true);
      
      if (this.timestamps.length > 0) {
        // Go to most recent image
        this.currentIndex = this.timestamps.length - 1;
        await this.updateRadarDisplay();
        this.updateTimeline();
        this.updateTimelineLabels();
      }
      
      this.updateStatusDisplay('Radar data refreshed');
    } catch (error) {
      console.error('Failed to refresh:', error);
      this.showError('Failed to refresh: ' + error.message);
    } finally {
      this.showLoading(false);
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄';
    }
  }

  async updateRadarDisplay() {
    if (this.timestamps.length === 0) return;
    
    const timestamp = this.timestamps[this.currentIndex];
    const cacheKey = `${this.config.radar_id}_${timestamp}`;
    
    // Check if image is in memory cache
    if (this.imageCache.has(cacheKey)) {
      this.displayCachedImage(cacheKey);
      return;
    }
    
    // Download image through proxy
    try {
      const imageUrl = `${this.ingressUrl}/api/radar/${this.config.radar_id}/${timestamp}`;
      
      // Cache the image URL
      this.imageCache.set(cacheKey, imageUrl);
      
      // Display image
      this.displayCachedImage(cacheKey);
      
      // Update timestamp display
      this.updateTimestampDisplay(timestamp);
    } catch (error) {
      console.error('Failed to load radar image:', error);
      this.updateStatusDisplay('Failed to load image: ' + error.message);
    }
  }

  displayCachedImage(cacheKey) {
    const imageUrl = this.imageCache.get(cacheKey);
    
    if (!imageUrl) return;
    
    // Remove old overlay
    if (this.currentOverlay) {
      this.map.removeLayer(this.currentOverlay);
    }
    
    // Calculate bounds based on radar location
    const bounds = this.calculateRadarBounds();
    
    // Add new overlay
    this.currentOverlay = L.imageOverlay(imageUrl, bounds, {
      opacity: this.config.opacity,
      interactive: false,
      crossOrigin: 'anonymous'
    });
    
    this.currentOverlay.addTo(this.map);
    
    // Update timestamp from cache key
    const timestamp = cacheKey.split('_')[1];
    this.updateTimestampDisplay(timestamp);
  }

  calculateRadarBounds() {
    const radarLoc = this.radarLocations[this.config.radar_id];
    const zoom = this.map.getZoom();
    
    // Determine radius based on zoom level
    let radiusKm;
    if (zoom >= 11) {
      radiusKm = 64;
    } else if (zoom >= 9) {
      radiusKm = 128;
    } else if (zoom >= 7) {
      radiusKm = 256;
    } else {
      radiusKm = 512;
    }
    
    // Convert radius to lat/lon degrees
    const latDelta = radiusKm / 111.32;
    const lonDelta = radiusKm / (111.32 * Math.cos(radarLoc.lat * Math.PI / 180));
    
    return [
      [radarLoc.lat - latDelta, radarLoc.lon - lonDelta],
      [radarLoc.lat + latDelta, radarLoc.lon + lonDelta]
    ];
  }

  updateTimestampDisplay(timestamp) {
    // Parse timestamp: yyyyMMddHHmm
    const year = timestamp.substring(0, 4);
    const month = timestamp.substring(4, 6);
    const day = timestamp.substring(6, 8);
    const hour = timestamp.substring(8, 10);
    const minute = timestamp.substring(10, 12);
    
    const date = new Date(year, month - 1, day, hour, minute);
    
    const formatted = date.toLocaleString('en-AU', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    
    const now = new Date();
    const ageMinutes = Math.round((now - date) / 60000);
    const ageText = ageMinutes < 60 ? `${ageMinutes}min ago` : `${Math.round(ageMinutes / 60)}hr ago`;
    
    this.querySelector('#timestamp-display').textContent = `${formatted} (${ageText})`;
  }

  updateStatusDisplay(message) {
    this.querySelector('#timestamp-display').textContent = message;
  }

  updateStatusInfo(message = '') {
    const zoom = this.map ? this.map.getZoom() : this.config.default_zoom;
    let radiusKm;
    
    if (zoom >= 11) radiusKm = 64;
    else if (zoom >= 9) radiusKm = 128;
    else if (zoom >= 7) radiusKm = 256;
    else radiusKm = 512;
    
    const statusText = message || `Zoom: ${zoom} (${radiusKm}km radius)`;
    const statusInfo = this.querySelector('#status-info');
    if (statusInfo) {
      statusInfo.textContent = statusText;
    }
  }

  updateTimeline() {
    const slider = this.querySelector('#timeline-slider');
    slider.max = Math.max(0, this.timestamps.length - 1);
    slider.value = this.currentIndex;
  }

  updateTimelineLabels() {
    if (this.timestamps.length === 0) return;
    
    const labelsContainer = this.querySelector('#timeline-labels');
    
    // Show first, middle, and last timestamp
    const first = this.timestamps[this.timestamps.length - 1]; // Oldest
    const last = this.timestamps[0]; // Newest
    
    const formatTime = (ts) => {
      const hour = ts.substring(8, 10);
      const minute = ts.substring(10, 12);
      return `${hour}:${minute}`;
    };
    
    labelsContainer.innerHTML = `
      <span>${formatTime(first)}</span>
      <span>${formatTime(last)}</span>
    `;
  }

  play() {
    if (this.isPlaying || this.timestamps.length === 0) return;
    
    this.isPlaying = true;
    this.querySelector('#play-btn').style.display = 'none';
    this.querySelector('#pause-btn').style.display = 'inline-block';
    
    this.playbackInterval = setInterval(() => {
      this.nextFrame();
    }, this.config.playback_speed);
  }

  pause() {
    this.isPlaying = false;
    this.querySelector('#play-btn').style.display = 'inline-block';
    this.querySelector('#pause-btn').style.display = 'none';
    
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
  }

  nextFrame() {
    if (this.timestamps.length === 0) return;
    
    this.currentIndex = (this.currentIndex + 1) % this.timestamps.length;
    this.updateRadarDisplay();
    this.updateTimeline();
  }

  previousFrame() {
    if (this.timestamps.length === 0) return;
    
    this.currentIndex = (this.currentIndex - 1 + this.timestamps.length) % this.timestamps.length;
    this.updateRadarDisplay();
    this.updateTimeline();
  }

  goToFrame(index) {
    if (index < 0 || index >= this.timestamps.length) return;
    
    this.currentIndex = index;
    this.updateRadarDisplay();
  }

  showLoading(show) {
    const overlay = this.querySelector('#loading-overlay');
    if (overlay) {
      overlay.style.display = show ? 'flex' : 'none';
    }
  }

  showError(message) {
    const errorEl = this.querySelector('#error-message');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        errorEl.style.display = 'none';
      }, 5000);
    }
  }

  getCardSize() {
    return 6;
  }

  static getConfigElement() {
    return document.createElement("leaflet-bom-radar-card-editor");
  }

  static getStubConfig() {
    return {
      radar_id: "IDR023",
      cache_hours: 2,
      playback_speed: 500,
      default_zoom: 8,
      opacity: 0.7,
      base_layer: "osm",
      auto_select_radar: true,
      show_legend: true,
      show_home_marker: true,
      show_radar_marker: true
    };
  }
}

customElements.define('leaflet-bom-radar-card', LeafletBomRadarCard);

// Register the card with Home Assistant
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'leaflet-bom-radar-card',
  name: 'Leaflet BoM Radar Card',
  description: 'Display Bureau of Meteorology radar imagery on an interactive Leaflet map',
  preview: false,
  documentationURL: 'https://github.com/safepay/leaflet-bom-radar-card',
});

console.info(
  '%c LEAFLET-BOM-RADAR-CARD %c Version 1.0.0 ',
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray'
);  
