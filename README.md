# Leaflet BoM Radar for Home Assistant

A complete solution for displaying Australian Bureau of Meteorology radar imagery in Home Assistant with dynamic, viewport-based radar loading.

[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)
[![hacs][hacs-shield]][hacs]

## Features

🗺️ **Dynamic Multi-Radar Display**
- Automatically loads all radars visible in your current view
- Seamlessly blends overlapping radar coverage
- No manual radar selection needed

📍 **Smart Location Awareness**
- Starts at your Home Assistant home location
- Automatically switches radars as you pan/zoom
- Shows only relevant radar data for your view

⚡ **Intelligent Caching**
- Historical images cached for 24 hours
- Current images refresh every 10 minutes based on image timestamp
- Automatic cache cleanup and size management

🌐 **Full Remote Access**
- Works with Nabu Casa, DuckDNS, or any remote access method
- Uses Home Assistant's secure ingress system
- Full mobile app support

## Components

This repository contains:

1. **Home Assistant Add-on** - Backend proxy server for BoM FTP access
2. **Custom Lovelace Card** - Interactive radar map display
3. **Custom Integration** - Sensors for radar status (optional)

## Quick Start

### 1. Add Repository to Home Assistant

**Settings** → **Add-ons** → **Add-on Store** → **⋮** (menu) → **Repositories**

Add this URL:
```
https://github.com/safepay/leaflet-bom-radar
```

### 2. Install the Add-on

1. Find "BoM Radar Proxy" in the add-on store
2. Click **Install**
3. Click **Start**
4. Enable **Show in sidebar** (optional)

### 3. Install the Card

#### Via HACS (Recommended)

1. Open **HACS** → **Frontend**
2. Click **⋮** → **Custom repositories**
3. Add: `https://github.com/safepay/leaflet-bom-radar`
4. Category: **Lovelace**
5. Install "Leaflet BoM Radar Card"
6. Restart Home Assistant

#### Manual Installation

1. Copy `www/community/leaflet-bom-radar-card/` to your `/config/www/community/`
2. Add resource in **Settings** → **Dashboards** → **Resources**:
   - URL: `/local/community/leaflet-bom-radar-card/leaflet-bom-radar-card.js`
   - Type: **JavaScript Module**
3. Restart Home Assistant

### 4. Add Card to Dashboard
```yaml
type: custom:leaflet-bom-radar-card
```

That's it! The card will automatically:
- Center on your home location
- Load all visible radars
- Update as you pan and zoom
- Refresh every 10 minutes

## How It Works

### Dynamic Radar Loading
```
User pans map → Calculate visible bounds → Find radars in view → Load images → Blend overlays
```

As you explore the map:
1. Card detects which radars are visible in your viewport
2. Automatically fetches timestamps for those radars
3. Downloads and displays radar imagery
4. Blends multiple radar images where coverage overlaps
5. Removes radars that pan out of view

### Intelligent Caching

**Image Timestamp Logic:**
- Uses the timestamp **in the filename** (not file modification time)
- Images older than 30 minutes (historical): Cached for 24 hours
- Images newer than 30 minutes (current): Re-downloaded if >10 minutes old
- Respects BoM's ~10 minute update interval

**Example:**
```
IDR023.T.202410231430.png
              ↑
        This timestamp determines cache freshness
```

## Configuration

### Minimal (Recommended)
```yaml
type: custom:leaflet-bom-radar-card
```

### Full Options
```yaml
type: custom:leaflet-bom-radar-card
cache_hours: 2                    # Hours of history to load (1-24)
playback_speed: 500               # Animation speed in ms
default_zoom: 8                   # Initial zoom level (5-15)
opacity: 0.7                      # Radar overlay opacity (0-1)
base_layer: osm                   # Base map: 'osm' or 'google'
show_legend: true                 # Show rainfall legend
fade_duration: 300                # Fade transition time in ms
max_radar_distance_km: 800        # Max distance to show radar
```

## Advanced Features

### Multiple Radar Coverage

The card automatically handles:
- **Overlapping radars**: Blends seamlessly
- **Gaps in coverage**: Shows only available data
- **Different resolutions**: Each radar shows its native resolution
- **Simultaneous updates**: All visible radars update independently

### Animation

Play through radar history for all visible radars:
- ▶ **Play/Pause**: Animate through time
- ⏮/⏭ **Previous/Next**: Step through frames
- 🔄 **Refresh**: Fetch latest images
- **Timeline Slider**: Scrub to any point in time

### Performance Optimization

**First Load:**
- Loads only radars visible in initial view
- ~2-5 seconds per radar
- Cached for subsequent views

**Panning:**
- New radars load automatically
- Smooth fade-in transitions
- Old radars fade out and unload

**Memory Management:**
- Active overlays only
- Automatic garbage collection
- Configurable cache limits

## Add-on Configuration
```yaml
log_level: info                    # debug, info, warn, error
cache_ttl_hours: 24                # How long to cache images
timestamp_refresh_interval: 600    # Seconds between timestamp refreshes
max_cache_size_mb: 1000           # Maximum cache size
```

## Supported Radars

All 60+ BoM radars across Australia are supported, including:

**Major Cities:**
- Melbourne (IDR023)
- Sydney (IDR713)
- Brisbane (IDR663)
- Adelaide (IDR643)
- Perth (IDR703)
- Hobart (IDR763)
- Darwin (IDR633)
- Canberra (IDR403)

**Regional Coverage:**
- Full coverage of populated areas
- Coastal monitoring
- Remote area coverage

See `www/community/leaflet-bom-radar-card/radars.json` for complete list.

## Mobile Support

✅ Works perfectly on:
- Home Assistant iOS app
- Home Assistant Android app
- Mobile web browsers
- Tablets

All functionality available remotely via:
- Nabu Casa Cloud
- DuckDNS
- Custom domain
- VPN

## Troubleshooting

### Add-on won't start
- Check logs: Settings → Add-ons → BoM Radar Proxy → Log
- Verify port 3000 isn't in use
- Ensure sufficient disk space

### Card shows blank map
- Verify add-on is running
- Check browser console (F12) for errors
- Clear browser cache
- Verify ingress is enabled in add-on

### No radar images loading
- Check add-on logs for FTP errors
- Verify internet connectivity
- Test add-on health: Open Web UI from add-on page
- Try refreshing with 🔄 button

### Radars not switching when panning
- Check browser console for errors
- Verify radar data loaded: Check add-on stats
- Try zooming in/out to trigger refresh

## API Endpoints

The add-on exposes these endpoints via ingress:
```
GET /api/radars                          # List all radars
GET /api/closest-radar?lat={lat}&lon={lon}  # Find closest radar
GET /api/timestamps/{radarId}            # Get available timestamps
GET /api/radar/{radarId}/{timestamp}     # Get radar image
GET /api/cache/stats                     # Cache statistics
GET /health                              # Health check
```

## Development

### Building the Add-on Locally
```bash
# Clone repository
git clone https://github.com/safepay/leaflet-bom-radar.git
cd leaflet-bom-radar

# Build for your architecture
docker build \
  --build-arg BUILD_FROM="homeassistant/amd64-base:latest" \
  -t local/bom-radar-proxy \
  ./bom-radar-proxy
```

### Testing the Card Locally
```bash
# Serve files locally
cd www/community/leaflet-bom-radar-card
python3 -m http.server 8000

# Access at http://localhost:8000
```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Changelog

See [CHANGELOG.md](CHANGELOG.md)

## License

MIT License - see [LICENSE](LICENSE)

## Credits

- **Leaflet.js** - Map library
- **OpenStreetMap** - Map tiles
- **Bureau of Meteorology** - Radar data
- **Home Assistant** - Smart home platform

## Support

- 📖 [Documentation](https://github.com/safepay/leaflet-bom-radar/wiki)
- 🐛 [Report Issues](https://github.com/safepay/leaflet-bom-radar/issues)
- 💬 [Discussions](https://github.com/safepay/leaflet-bom-radar/discussions)

## Screenshots

![Dynamic Radar Loading](screenshots/dynamic-loading.gif)
*Radars automatically load as you pan the map*

![Multiple Radar Coverage](screenshots/multi-radar.png)
*Seamless blending of overlapping radar coverage*

![Mobile View](screenshots/mobile.png)
*Full functionality on mobile devices*

---

**Made with ❤️ for the Home Assistant community**

[releases-shield]: https://img.shields.io/github/release/safepay/leaflet-bom-radar.svg
[releases]: https://github.com/safepay/leaflet-bom-radar/releases
[license-shield]: https://img.shields.io/github/license/safepay/leaflet-bom-radar.svg
[hacs-shield]: https://img.shields.io/badge/HACS-Default-41BDF5.svg
[hacs]: https://github.com/hacs/integration
