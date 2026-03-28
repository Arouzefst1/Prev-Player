# 🎬 PREV Player

**A powerful, responsive video player that works everywhere** - Android, Windows, macOS, Linux, and iOS. **Installs as a native app with offline support and auto-updates!**

---

## ✨ Features

✅ **Installable PWA** - Install on any device like a native app  
✅ **Offline Support** - Watch videos without internet  
✅ **Auto-Update** - Automatically updates when code changes  
✅ **Responsive Design** - Works on mobile, tablet, desktop, foldable phones  
✅ **Advanced Controls** - Keyboard shortcuts, touch gestures, playlists  
✅ **Subtitle Support** - VTT and SRT subtitles  
✅ **Playback Speed** - 0.25x to 2x speed control  
✅ **Full HD Quality** - Supports all video formats  

---

## 🚀 Quick Start

### Run Locally

**Prerequisites:** Node.js v16+

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run the dev server:**
   ```bash
   npm run dev
   ```

3. **Open in browser:**
   - Local: http://localhost:3001
   - Network: http://YOUR_IP:3001

---

## 📱 Install as App

### On Android
1. Open in Chrome → Menu (⋮) → "Install app" ✅

### On Windows/Desktop
1. Open in Chrome/Edge → Click install icon → Done! ✅

### On macOS
1. Chrome: Menu → "Install app"
2. Safari: File → "Add to Dock" ✅

### On iOS/iPad
1. Safari → Share → "Add to Home Screen" ✅

**That's it!** App runs full-screen like a native app.

---

## 🎮 Controls

### Keyboard (Desktop)
| Key | Action |
|-----|--------|
| **K** | Play/Pause |
| **Space** | Play/Pause or 2x Speed (hold) |
| **L** | Forward 10s |
| **J** | Rewind 10s |
| **F** | Fullscreen |
| **M** | Mute |
| **C** | Toggle Subtitles |
| **0-9** | Jump to 0-90% |
| **< / >** | Speed Down/Up |

### Touch (Mobile/Tablet)
| Gesture | Action |
|---------|--------|
| **Tap** | Play/Pause |
| **Double-tap** | Fullscreen |
| **Hold 500ms** | 2x Speed |
| **Tap time** | Toggle remaining time |

---

## 🔄 Auto-Update Feature

Your app automatically checks for updates every **5 minutes** when online:

1. You update code → Dev server reloads
2. App detects change → Auto-reloads
3. Users see latest version instantly

**No manual refresh needed!** Just deploy code and it updates everywhere.

---

## 📂 Project Structure

```
Video-player/
├── components/
│   ├── VideoPlayer.tsx      # Main player component
│   ├── PlayerControls.tsx    # Control bar
│   └── ActionOverlay.tsx     # Overlay animations
├── public/
│   ├── manifest.json        # PWA manifest
│   ├── service-worker.js    # Offline & update handler
│   └── icons/               # App icons (SVG)
├── App.tsx                  # Main app component
├── index.html               # With PWA meta tags
└── README.md               # This file
```

---

## 🔒 PWA Security

✅ **HTTPS ready** - Secure with HTTPS in production  
✅ **No tracking** - No analytics or telemetry  
✅ **No data sharing** - Everything stays local  
✅ **Offline by default** - Works without internet  
✅ **Permission-based** - Only asks what's needed  

---

## 📚 Documentation

- **[INSTALLATION.md](INSTALLATION.md)** - Complete setup & installation guide ⭐ START HERE
- **[QUICK_START.md](QUICK_START.md)** - Quick reference guide
- **[PWA_SETUP.md](PWA_SETUP.md)** - Detailed device-specific installation
- **[PWA_COMPLETE.md](PWA_COMPLETE.md)** - Full technical documentation

---

## 🛠️ Build for Production

```bash
npm run build
```

Deploys to `/dist` folder. Serve with:
- **Nginx/Apache**: Standard web server
- **Node.js**: Express or similar
- **Vercel/Netlify**: Zero-config deployment

**Important**: Must be served over HTTPS (except localhost) for PWA.

---

## 🌐 Browser Support

| Browser | Desktop | Mobile | Offline | PWA |
|---------|---------|--------|---------|-----|
| Chrome | ✅ | ✅ | ✅ | ✅ |
| Edge | ✅ | ✅ | ✅ | ✅ |
| Firefox | ✅ | ✅ | ✅ | ✅ |
| Safari | ✅ | ✅ | ✅ | ⚠️ |

*Safari: Offline works, but PWA install limited on iOS*

---

## 🎯 Use Cases

🎬 **Personal Media Library** - Store and play your videos locally  
📱 **Mobile App** - Install on phone like YouTube  
💼 **Enterprise** - Deploy internally, no internet needed  
🎓 **Education** - Offline educational videos  
🌍 **Offline Region** - Works without internet  

---

## 🚀 Deployment Options

### Local Network
```bash
npm run dev
# Then visit: http://YOUR_IP:3001 on other devices
```

### Docker
```bash
docker build -t zenith-player .
docker run -p 3001:3001 zenith-player
```

### Cloud Hosting
- **Vercel**: `vercel deploy`
- **Netlify**: `netlify deploy`
- **GitHub Pages**: Static hosting
- **Your Server**: Copy `/dist` to web root

---

## 📊 Performance

- **App Size**: 2-3 MB
- **Cache Size**: ~50+ MB auto-managed
- **Load Time**: < 2 seconds
- **Offline**: Instant launch
- **Streaming**: Up to 4K quality

---

## 🐛 Troubleshooting

**App won't install?**
- Use Chrome/Edge browser
- Disable ad-blockers
- Clear browser cache
- Try incognito mode

**Not updating?**
- Close and reopen app
- Check internet connection
- Pull to refresh manually

**Can't play offline?**
- Load video online first (gets cached)
- Ensure enough storage space
- Check file format compatibility

See **[PWA_SETUP.md](PWA_SETUP.md)** for more help.

---

## 📝 License

MIT License - Use freely in personal and commercial projects.

---

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

---

## 🎉 Ready to Use!

1. Run `npm install && npm run dev`
2. Open http://localhost:3001
3. Click install button
4. Enjoy your new app! 🚀

**Questions?** See the documentation files above.
