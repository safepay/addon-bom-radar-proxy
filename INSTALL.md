# Installation Guide

Complete installation instructions for the Leaflet BoM Radar system.

## Prerequisites

- Home Assistant 2023.1.0 or newer
- At least 1GB free disk space for radar cache
- Internet connection for downloading radar images

## Step-by-Step Installation

### 1. Add the Repository to Home Assistant

1. Open Home Assistant
2. Navigate to **Settings** → **Add-ons** → **Add-on Store**
3. Click the **⋮** menu (three dots) in the top right
4. Select **Repositories**
5. Add this URL:
```
   https://github.com/safepay/leaflet-bom-radar
```
6. Click **Add**

### 2. Install the Add-on

1. Refresh the Add-on Store page
2. Find "**BoM Radar Proxy**" in the list
3. Click on it to open the add-on page
4. Click **Install**
5. Wait for installation to complete (may take 5-10 minutes)
6. Click **Start**
7. (Optional) Enable **Start on boot** and **Watchdog**
8. (Optional) Enable **Show in sidebar** for easy access

### 3. Configure the Add-on (Optional)

Default settings work for most users, but you can customize:

1. Go to the **Configuration** tab
2. Adjust settings if needed:
```yaml
   log_level: info
   cache_ttl_hours: 24
   timestamp_refresh_interval: 600
   max_cache_size_mb: 1000
```
3. Click **Save**
4. Restart the add-on if you changed settings

### 4. Verify Add-on is Running

1. Check the **Info** tab shows "Running"
2. Check the **Log** tab for any errors
3. You should see: `BoM Radar Proxy Add-on started`
4. Click **Open Web UI** to test the API (optional)

### 5. Install the Custom Card

#### Option A: Install via HACS (Recommended)

1. Open **HACS** in Home Assistant
2. Go to **Frontend**
3. Click the **⋮** menu (three dots) in the top right
4. Select **Custom repositories**
5. Add repository:
   - **URL**: `https://github.com/safepay/leaflet-bom-radar`
   - **Category**: **Lovelace**
6. Click **Add**
7. Find "**Leaflet BoM Radar Card**" in the list
8. Click **Download**
9. Restart Home Assistant

#### Option B: Manual Installation

1. Download the latest release from GitHub
2. Extract the files
3. Copy the entire `www/community/leaflet-bom-radar-card/` folder to your Home Assistant:
```
   /config/www/community/leaflet-bom-radar-card/
```
4. Add the resource to Lovelace:
   - Go to **Settings** → **Dashboards** → **Resources**
   - Click **Add Resource**
   - **URL**: `/local/community/leaflet-bom-radar-card/leaflet-bom-radar-card.js`
   - **Resource type**: **JavaScript Module**
   - Click **Create**
5. Restart Home Assistant

### 6. Verify Card is Loaded

1. Open browser console (F12)
2. Refresh Home Assistant
3. Look for: `LEAFLET-BOM-RADAR-CARD Version 2.0.0`
4. No errors should appear

### 7. Add Card to Dashboard

#### Via UI Editor

1. Go to any dashboard
2. Click **Edit Dashboard** (pencil icon)
3. Click **Add Card**
4. Search for "**Leaflet BoM Radar**"
5. Click on the card
6. Click **Save** (default configuration works great!)

#### Via YAML

Add to your dashboard YAML:
```yaml
type: custom:leaflet-bom-radar-card
cache_hours: 2
default_zoom: 8
opacity: 0.7
```

### 8. First Launch

1. The card will load and center on your Home Assistant location
2. Initial load may take 10-30 seconds
3. You should see:
   - Interactive map
   - Radar overlay(s)
   - Playback controls
   - Timeline slider
4. Try panning and zooming - radars will load automatically!

## Troubleshooting Installation

### Add-on won't start

**Check:**
- Logs in the add-on Log tab
- Sufficient disk space (need 1GB+)
- Port 3000 not in use by another service

**Solution:**
```bash
# Check Home Assistant logs
ha addons logs local_bom_radar_proxy
```

### Card not showing in add card menu

**Check:**
- Resource added correctly in Settings → Dashboards → Resources
- URL path is correct
- Home Assistant restarted after adding resource

**Solution:**
1. Clear browser cache (Ctrl+Shift+Delete)
2. Hard refresh (Ctrl+Shift+R)
3. Check browser console for errors

### "Failed to load radar locations"

**Check:**
- Add-on is running (green dot on Info tab)
- Ingress is enabled in add-on config
- Network connectivity

**Solution:**
1. Restart the add-on
2. Check add-on logs for errors
3. Test add-on API by opening Web UI

### Blank map displays

**Check:**
- Internet connectivity (needs to load map tiles)
- Browser console for errors
- Leaflet.js loaded successfully

**Solution:**
1. Clear browser cache
2. Check network tab in browser console
3. Verify no ad-blockers interfering

### Radar images not loading

**Check:**
- Add-on can connect to BoM FTP server
- Check add-on logs for FTP errors
- Your location is within Australia

**Solution:**
1. Check add-on logs for connection errors
2. Verify internet connectivity
3. Try manual refresh with 🔄 button

## Verification Checklist

- [ ] Add-on shows "Running" in Info tab
- [ ] Add-on logs show no errors
- [ ] Resource appears in Settings → Dashboards → Resources
- [ ] Card appears in "Add Card" search
- [ ] Map displays on dashboard
- [ ] Radar imagery overlays on map
- [ ] Playback controls work
- [ ] Pan/zoom loads new radars automatically
- [ ] Works on mobile app

## Next Steps

Once installed:
1. Read the [User Guide](USER_GUIDE.md)
2. Explore [Configuration Options](README.md#configuration)
3. Check out [Advanced Features](README.md#advanced-features)
4. Join [Discussions](https://github.com/safepay/leaflet-bom-radar/discussions)

## Getting Help

If you encounter issues:

1. Check the [Troubleshooting Guide](TROUBLESHOOTING.md)
2. Search [existing issues](https://github.com/safepay/leaflet-bom-radar/issues)
3. Join [community discussions](https://github.com/safepay/leaflet-bom-radar/discussions)
4. [Open a new issue](https://github.com/safepay/leaflet-bom-radar/issues/new/choose)

## Upgrading

### Via HACS
1. HACS will notify you of updates
2. Click **Update** in HACS → Frontend
3. Restart Home Assistant

### Manual Upgrade
1. Download latest release
2. Replace files in `/config/www/community/leaflet-bom-radar-card/`
3. Clear browser cache
4. Restart Home Assistant

## Uninstallation

To completely remove:

1. Remove card from all dashboards
2. Remove resource from Settings → Dashboards → Resources
3. Stop and uninstall add-on from Settings → Add-ons
4. Delete `/config/www/community/leaflet-bom-radar-card/` folder
5. Restart Home Assistant
```

## Summary

You now have a **complete, production-ready GitHub repository** with:

### ✅ Dynamic Radar Loading
- Automatically detects radars in viewport
- Loads/unloads radars as user pans
- Seamless blending of overlapping coverage
- No manual radar selection needed

### ✅ Smart Home Integration
- Starts at Home Assistant home location
- Uses HA lat/long from configuration
- Full ingress support for remote access
- Works on mobile apps automatically

### ✅ Intelligent Caching
- Timestamp-based expiry (not file modification time)
- Current images (<30min) refresh every 10min
- Historical images (>30min) cached 24 hours
- Automatic cleanup and size management

### ✅ Complete Documentation
- Installation guide
- Configuration reference
- Troubleshooting steps
- Contributing guidelines
- Issue templates

### ✅ GitHub Actions CI/CD
- Automatic builds for all architectures
- Linting and validation
- Release automation

### ✅ HACS Compatible
- Easy installation via HACS
- Automatic updates
- Version management

### Installation for Users:
```
1. Add repo: https://github.com/safepay/leaflet-bom-radar
2. Install add-on from Add-on Store
3. Install card from HACS
4. Add card to dashboard
5. Done! No configuration needed.
