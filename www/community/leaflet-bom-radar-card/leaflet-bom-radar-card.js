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
      .leaflet-fade-anim .leaflet-popup {
        transition: opacity ${this.config.fade_duration}ms;
      }
      .leaflet-zoom-anim .leaflet-zoom-animated {
        transition: transform 0.25s cubic-bezier(0,0,0.25,1);
      }
      
      /* Responsive design */
      @media (max-width: 600px) {
        .card-header {
          flex-direction: column;
          align-items: stretch;
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
    await this.loadLeaflet();
    
    // Get home location from Home Assistant
    const latitude = this._hass.config.latitude || -37.8136; // Default Melbourne
    const longitude = this._hass.config.longitude || 144.9631;
    
    this.map = L.map(this.querySelector('#radar-map'), {
      zoomControl: false,
      attributionControl: true,
      fadeAnimation: true,
      zoomAnimation: true,
      markerZoomAnimation: true
    }).setView([latitude, longitude], this.config.default_zoom);
    
    // Add zoom control to top right
    L.control.zoom({
      position: 'topright'
    }).addTo(this.map);
    
    // Add attribution
    this.map.attributionControl.setPrefix('Leaflet');
    
    // Add base layer
    this.addBaseLayer();
    
    // Add home marker
    this.addHomeMarker(latitude, longitude);
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Monitor map viewport changes
    this.map.on('moveend zoomend', () => {
      this.onViewportChange();
    });
  }

  async loadLeaflet() {
    if (window.L) return;
    
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
      link.crossOrigin = '';
      document.head.appendChild(link);
      
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

  setupEventListeners() {
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
      const homeLat = this._hass.config.latitude || -37.8136;
      const homeLon = this._hass.config.longitude || 144.9631;
      this.map.setView([homeLat, homeLon], this.config.default_zoom);
    });
  }

  async initializeViewport() {
    this.showLoading(true);
    this.updateStatusDisplay('Detecting visible radars...');
    
    try {
      await this.updateVisibleRadars();
      
      if (this.visibleRadars.size === 0) {
        this.updateStatusDisplay('No radars in view. Pan or zoom out to see radar coverage.');
        this.showLoading(false);
        return;
      }
      
      await this.loadTimestampsForVisibleRadars();
      await this.buildTimelineFromAllRadars();
      
      if (this.allTimestamps.length > 0) {
        this.currentFrameIndex = this.allTimestamps.length - 1; // Start with most recent
        await this.displayCurrentFrame();
        this.updateTimeline();
        this.updateTimelineLabels();
      }
      
      this.updateRadarInfo();
      this.showLoading(false);
    } catch (error) {
      console.error('Failed to initialize viewport:', error);
      this.showError('Failed to load radar data: ' + error.message);
      this.showLoading(false);
    }
  }

  onViewportChange() {
    // Debounce viewport changes to avoid excessive updates
    clearTimeout(this.updateViewportDebounce);
    this.updateViewportDebounce = setTimeout(() => {
      this.updateVisibleRadarsAndDisplay();
    }, 300);
  }

  async updateVisibleRadarsAndDisplay() {
    const previousRadars = new Set(this.visibleRadars);
    await this.updateVisibleRadars();
    
    // Check if visible radars changed
    const radarsChanged = !this.setsEqual(previousRadars, this.visibleRadars);
    
    if (radarsChanged) {
      console.log(`Visible radars changed. Now showing: ${Array.from(this.visibleRadars).join(', ')}`);
      
      // Load timestamps for new radars
      await this.loadTimestampsForVisibleRadars();
      
      // Rebuild timeline
      await this.buildTimelineFromAllRadars();
      
      // Update display
      if (this.allTimestamps.length > 0) {
        // Try to maintain similar timestamp position
        this.currentFrameIndex = Math.min(this.currentFrameIndex, this.allTimestamps.length - 1);
        await this.displayCurrentFrame();
        this.updateTimeline();
        this.updateTimelineLabels();
      }
      
      this.updateRadarInfo();
      
      // Remove overlays for radars no longer visible
      this.cleanupHiddenRadars();
    }
  }

  async updateVisibleRadars() {
    const bounds = this.map.getBounds();
    const center = this.map.getCenter();
    
    this.visibleRadars.clear();
    
    // Find all radars within viewport or within max distance
    for (const [id, radar] of Object.entries(this.radarLocations)) {
      const radarLatLng = L.latLng(radar.lat, radar.lon);
      
      // Check if radar is within bounds or within max distance from center
      const distanceKm = center.distanceTo(radarLatLng) / 1000;
      
      if (bounds.contains(radarLatLng) || distanceKm <= this.config.max_radar_distance_km) {
        // Additionally check if radar coverage would be visible in viewport
        if (this.isRadarCoverageVisible(radar, bounds)) {
          this.visibleRadars.add(id);
        }
      }
    }
    
    console.log(`Found ${this.visibleRadars.size} visible radars:`, Array.from(this.visibleRadars));
  }

  isRadarCoverageVisible(radar, bounds) {
    // Check if any part of the radar's coverage area intersects with viewport
    // Radar coverage is approximately 512km radius (max range)
    const maxRadiusKm = 512;
    const radarLatLng = L.latLng(radar.lat, radar.lon);
    
    // Calculate approximate bounds of radar coverage
    const latDelta = maxRadiusKm / 111.32;
    const lonDelta = maxRadiusKm / (111.32 * Math.cos(radar.lat * Math.PI / 180));
    
    const radarBounds = L.latLngBounds(
      [radar.lat - latDelta, radar.lon - lonDelta],
      [radar.lat + latDelta, radar.lon + lonDelta]
    );
    
    // Check if radar bounds intersect with viewport bounds
    return bounds.intersects(radarBounds);
  }

  async loadTimestampsForVisibleRadars() {
    const fetchPromises = [];
    
    for (const radarId of this.visibleRadars) {
      // Check if we need to fetch timestamps
      const lastFetch = this.lastTimestampFetch.get(radarId) || 0;
      const timeSinceLastFetch = Date.now() - lastFetch;
      
      if (timeSinceLastFetch >= this.MIN_FETCH_INTERVAL || !this.radarTimestamps.has(radarId)) {
        fetchPromises.push(this.fetchTimestampsForRadar(radarId));
      }
    }
    
    if (fetchPromises.length > 0) {
      this.updateStatusDisplay(`Loading timestamps for ${fetchPromises.length} radar(s)...`);
      await Promise.allSettled(fetchPromises);
    }
  }

  async fetchTimestampsForRadar(radarId) {
    try {
      const limit = Math.ceil((this.config.cache_hours * 60) / 10);
      const response = await this.apiRequest(`/api/timestamps/${radarId}?limit=${limit}`);
      const data = await response.json();
      
      this.radarTimestamps.set(radarId, data.timestamps || []);
      this.lastTimestampFetch.set(radarId, Date.now());
      
      console.log(`Fetched ${data.timestamps.length} timestamps for ${radarId}`);
    } catch (error) {
      console.error(`Failed to fetch timestamps for ${radarId}:`, error);
      this.radarTimestamps.set(radarId, []);
    }
  }

  async buildTimelineFromAllRadars() {
    // Collect all unique timestamps from all visible radars
    const timestampSet = new Set();
    
    for (const radarId of this.visibleRadars) {
      const timestamps = this.radarTimestamps.get(radarId) || [];
      timestamps.forEach(ts => timestampSet.add(ts));
    }
    
    // Sort timestamps chronologically (oldest to newest)
    this.allTimestamps = Array.from(timestampSet).sort();
    
    console.log(`Built timeline with ${this.allTimestamps.length} unique timestamps`);
  }

  async displayCurrentFrame() {
    if (this.allTimestamps.length === 0) return;
    
    const currentTimestamp = this.allTimestamps[this.currentFrameIndex];
    
    // Display all visible radars for this timestamp
    const displayPromises = [];
    
    for (const radarId of this.visibleRadars) {
      const timestamps = this.radarTimestamps.get(radarId) || [];
      
      // Find closest available timestamp for this radar
      const closestTimestamp = this.findClosestTimestamp(timestamps, currentTimestamp);
      
      if (closestTimestamp) {
        displayPromises.push(this.displayRadarImage(radarId, closestTimestamp));
      }
    }
    
    await Promise.allSettled(displayPromises);
    
    this.updateTimestampDisplay(currentTimestamp);
  }

  findClosestTimestamp(timestamps, targetTimestamp) {
    if (timestamps.length === 0) return null;
    
    // Find the timestamp closest to (but not later than) the target
    let closest = null;
    let minDiff = Infinity;
    
    for (const ts of timestamps) {
      if (ts <= targetTimestamp) {
        const diff = parseInt(targetTimestamp) - parseInt(ts);
        if (diff < minDiff) {
          minDiff = diff;
          closest = ts;
        }
      }
    }
    
    // If no timestamp before target, use earliest available
    return closest || timestamps[0];
  }

  async displayRadarImage(radarId, timestamp) {
    const cacheKey = `${radarId}_${timestamp}`;
    const overlayId = `${radarId}_overlay`;
    
    // Get or cache image URL
    if (!this.imageCache.has(cacheKey)) {
      const imageUrl = `${this.ingressUrl}/api/radar/${radarId}/${timestamp}`;
      this.imageCache.set(cacheKey, imageUrl);
    }
    
    const imageUrl = this.imageCache.get(cacheKey);
    const radar = this.radarLocations[radarId];
    
    // Calculate bounds for this radar
    const bounds = this.calculateRadarBounds(radar);
    
    // Remove old overlay for this radar if exists
    if (this.activeOverlays.has(overlayId)) {
      const oldOverlay = this.activeOverlays.get(overlayId);
      
      // Fade out old overlay
      if (oldOverlay._image) {
        oldOverlay._image.style.transition = `opacity ${this.config.fade_duration}ms`;
        oldOverlay._image.style.opacity = '0';
        
        setTimeout(() => {
          this.map.removeLayer(oldOverlay);
        }, this.config.fade_duration);
      } else {
        this.map.removeLayer(oldOverlay);
      }
    }
    
    // Create new overlay
    const overlay = L.imageOverlay(imageUrl, bounds, {
      opacity: 0, // Start invisible for fade-in
      interactive: false,
      crossOrigin: 'anonymous',
      className: `radar-overlay radar-${radarId}`
    });
    
    overlay.addTo(this.map);
    this.activeOverlays.set(overlayId, overlay);
    
    // Fade in new overlay
    overlay.on('load', () => {
      if (overlay._image) {
        overlay._image.style.transition = `opacity ${this.config.fade_duration}ms`;
        setTimeout(() => {
          overlay.setOpacity(this.config.opacity);
        }, 10);
      }
    });
  }

  calculateRadarBounds(radar) {
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
    const lonDelta = radiusKm / (111.32 * Math.cos(radar.lat * Math.PI / 180));
    
    return [
      [radar.lat - latDelta, radar.lon - lonDelta],
      [radar.lat + latDelta, radar.lon + lonDelta]
    ];
  }

  cleanupHiddenRadars() {
    // Remove overlays for radars no longer visible
    for (const [overlayId, overlay] of this.activeOverlays.entries()) {
      const radarId = overlayId.replace('_overlay', '');
      
      if (!this.visibleRadars.has(radarId)) {
        // Fade out and remove
        if (overlay._image) {
          overlay._image.style.transition = `opacity ${this.config.fade_duration}ms`;
          overlay._image.style.opacity = '0';
          
          setTimeout(() => {
            this.map.removeLayer(overlay);
            this.activeOverlays.delete(overlayId);
          }, this.config.fade_duration);
        } else {
          this.map.removeLayer(overlay);
          this.activeOverlays.delete(overlayId);
        }
      }
    }
  }

  updateRadarInfo() {
    const radarInfo = this.querySelector('#radar-info');
    if (radarInfo) {
      const count = this.visibleRadars.size;
      const radarNames = Array.from(this.visibleRadars)
        .map(id => this.radarLocations[id].name)
        .join(', ');
      
      radarInfo.textContent = count > 0 
        ? `Showing ${count} radar${count > 1 ? 's' : ''}: ${radarNames}`
        : 'No radars in view';
    }
  }

  updateTimestampDisplay(timestamp) {
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
    const ageText = ageMinutes < 60 
      ? `${ageMinutes}min ago` 
      : `${Math.round(ageMinutes / 60)}hr ago`;
    
    this.querySelector('#timestamp-display').textContent = `${formatted} (${ageText})`;
  }

  updateStatusDisplay(message) {
    this.querySelector('#timestamp-display').textContent = message;
  }

  updateTimeline() {
    const slider = this.querySelector('#timeline-slider');
    slider.max = Math.max(0, this.allTimestamps.length - 1);
    slider.value = this.currentFrameIndex;
  }

  updateTimelineLabels() {
    if (this.allTimestamps.length === 0) return;
    
    const labelsContainer = this.querySelector('#timeline-labels');
    const first = this.allTimestamps[0]; // Oldest
    const last = this.allTimestamps[this.allTimestamps.length - 1]; // Newest
    
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

  async refreshRadarData() {
    const refreshBtn = this.querySelector('#refresh-btn');
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳';
    
    this.showLoading(true);
    
    try {
      // Force refresh timestamps for all visible radars
      const fetchPromises = [];
      for (const radarId of this.visibleRadars) {
        fetchPromises.push(this.fetchTimestampsForRadar(radarId));
      }
      
      await Promise.allSettled(fetchPromises);
      
      // Rebuild timeline
      await this.buildTimelineFromAllRadars();
      
      if (this.allTimestamps.length > 0) {
        // Go to most recent frame
        this.currentFrameIndex = this.allTimestamps.length - 1;
        await this.displayCurrentFrame();
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

  play() {
    if (this.isPlaying || this.allTimestamps.length === 0) return;
    
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

  async nextFrame() {
    if (this.allTimestamps.length === 0) return;
    
    this.currentFrameIndex = (this.currentFrameIndex + 1) % this.allTimestamps.length;
    await this.displayCurrentFrame();
    this.updateTimeline();
  }

  async previousFrame() {
    if (this.allTimestamps.length === 0) return;
    
    this.currentFrameIndex = (this.currentFrameIndex - 1 + this.allTimestamps.length) % this.allTimestamps.length;
    await this.displayCurrentFrame();
    this.updateTimeline();
  }

  async goToFrame(index) {
    if (index < 0 || index >= this.allTimestamps.length) return;
    
    this.currentFrameIndex = index;
    await this.displayCurrentFrame();
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
      
      setTimeout(() => {
        errorEl.style.display = 'none';
      }, 5000);
    }
  }

  setsEqual(set1, set2) {
    if (set1.size !== set2.size) return false;
    for (const item of set1) {
      if (!set2.has(item)) return false;
    }
    return true;
  }

  getCardSize() {
    return 6;
  }

  static getConfigElement() {
    return document.createElement("leaflet-bom-radar-card-editor");
  }

  static getStubConfig() {
    return {
      cache_hours: 2,
      playback_speed: 500,
      default_zoom: 8,
      opacity: 0.7,
      base_layer: "osm",
      show_legend: true,
      fade_duration: 300,
      max_radar_distance_km: 800
    };
  }
}

customElements.define('leaflet-bom-radar-card', LeafletBomRadarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'leaflet-bom-radar-card',
  name: 'Leaflet BoM Radar Card',
  description: 'Dynamic multi-radar display with viewport-based loading',
  preview: false,
  documentationURL: 'https://github.com/safepay/leaflet-bom-radar',
});

console.info(
  '%c LEAFLET-BOM-RADAR-CARD %c Version 2.0.0 ',
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray'
);
