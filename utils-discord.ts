/// <reference types="vite/client" />
/**
 * Utility to send notifications to Discord Webhook
 * Used for monitoring system activation and critical errors.
 */

// Rate limiting prevent spam during reconnect loops
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN = 60000; // 1 minute cooldown

export const sendDiscordNotification = async (message: string, type: 'info' | 'error' = 'info') => {
    // Option 1: Env Var (Recommended) || Option 2: Hardcoded (Fallback)
    const webhookUrl = import.meta.env.VITE_DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1469290133864976446/4BZOmhbPdmPOBIdo3YTgSk29StrBeEOroComl26Moa5YSsHgtHW_UeTiiEdJI7cJl00H";

    // Debug log to confirm env var load (Masked)
    if (!webhookUrl || webhookUrl === "YOUR_WEBHOOK_URL_HERE") {
        // console.warn('[Discord] MISSING WEBHOOK URL (Check .env or Hardcoded value)');
        return;
    }

    // Check cooldown
    const now = Date.now();
    if (now - lastNotificationTime < NOTIFICATION_COOLDOWN) {
        console.log('[Discord] Notification skipped (Cooldown active)');
        return;
    }

    try {
        // ---------------------------------------------------------
        // 0. SECURITY IDENTITY (Persistent ID)
        // ---------------------------------------------------------
        // Generate a unique ID for this browser and save it. 
        // This allows tracking the "Same Device" even if IP changes.
        let deviceId = localStorage.getItem('kiosk_device_id');
        if (!deviceId) {
            deviceId = crypto.randomUUID();
            localStorage.setItem('kiosk_device_id', deviceId);
        }

        // ---------------------------------------------------------
        // 1. DATA GATHERING
        // ---------------------------------------------------------

        // A. Native System Info (Electron) or Browser Fallback
        let sysInfo = {
            device: "Unknown Device",
            os: "Unknown Platform",
            cpu: "Unknown CPU",
            ram: "Unknown RAM",
            user: "Unknown User",
            mac: "Hidden (Web)",
            localIp: "Hidden (Web)",
            gpu: "Unknown GPU"
        };

        // GPU Fingerprinting
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') as WebGLRenderingContext;
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
                sysInfo.gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
            }
        } catch (e) { }

        // 2. Network Speed/Type (Chrome specific)
        const conn = (navigator as any).connection;

        // 3. Audio Peripherals (Specific Mic/Speaker Names)
        let audioDevices = { mic: "Unknown Mic", speaker: "Unknown Speaker", count: 0 };
        try {
            // Must enforce permissions first usually, but assuming typical usage flow
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === 'audioinput').map(d => d.label || "Generic Mic");
            const speakers = devices.filter(d => d.kind === 'audiooutput').map(d => d.label || "Generic Speaker");

            audioDevices = {
                mic: mics[0] || "None",
                speaker: speakers[0] || "None",
                count: devices.length
            };

            // If multiple, show count
            if (mics.length > 1) audioDevices.mic += ` (+${mics.length - 1} others)`;
        } catch (e) { }

        // 4. Battery Status (Health)
        let batteryInfo = "Plugged In / Desktop";
        try {
            const bat = (navigator as any).getBattery ? await (navigator as any).getBattery() : null;
            if (bat) {
                const percent = Math.round(bat.level * 100);
                const status = bat.charging ? "⚡ Charging" : "🔋 Battery";
                batteryInfo = `${status} ${percent}%`;
            }
        } catch (e) { }

        let sysUptime = "Unknown";

        // Safe Electron Access
        const electron = (window as any).electronAPI;

        if (electron) {
            try {
                const info = await electron.getSystemInfo();
                sysInfo.device = info.hostname;

                // Prioritize Distro Name (e.g. Fedora) over generic "Linux"
                if (info.distro && info.distro !== "Unknown") {
                    sysInfo.os = `${info.distro} (${info.arch})`;
                } else {
                    sysInfo.os = `${info.type} ${info.release} (${info.arch})`;
                }

                sysInfo.cpu = info.cpus;
                sysInfo.ram = `${Math.round(info.totalmem / (1024 * 1024 * 1024))} GB`;
                sysInfo.user = info.userInfo;
                sysInfo.mac = info.mac;
                sysInfo.localIp = info.localIp;

                // Uptime parsing
                const upHours = Math.floor(info.uptime / 3600);
                const upMins = Math.floor((info.uptime % 3600) / 60);
                sysUptime = `${upHours}h ${upMins}m`;

                // In Electron, use MAC as the primary Identity if available
                // if (info.mac && info.mac !== "Unknown") {
                //     deviceId = `MAC: ${info.mac}`;
                // }
            } catch (e) {
                console.warn("Electron API failed", e);
            }
        } else {
            // Browser Fallback logic kept same...
            // Browser Fallback
            const nav = navigator as any;
            sysInfo.os = nav.userAgentData?.platform || nav.platform || "Unknown OS";

            // Smart User-Agent Parsing for "Device Name"
            let ua = nav.userAgent;
            if (ua.includes("Windows")) sysInfo.device = "Windows PC (Web)";
            else if (ua.includes("Macintosh")) sysInfo.device = "Macbook/iMac (Web)";
            else if (ua.includes("Linux")) sysInfo.device = "Linux Machine (Web)";
            else if (ua.includes("Android")) sysInfo.device = "Android Device";
            else if (ua.includes("iPhone")) sysInfo.device = "iPhone";
            else sysInfo.device = "Web Client";

            if (ua.includes("Chrome")) sysInfo.device += " [Chrome]";
            else if (ua.includes("Firefox")) sysInfo.device += " [Firefox]";
            else if (ua.includes("Safari") && !ua.includes("Chrome")) sysInfo.device += " [Safari]";

            if (nav.hardwareConcurrency) sysInfo.cpu = `${nav.hardwareConcurrency} Cores (Logical)`;
            if (nav.deviceMemory) sysInfo.ram = `~${nav.deviceMemory} GB`;

            sysUptime = "Hidden (Web Privacy)";
        }

        // B. Native Geolocation (HTML5)
        let geo = { lat: 0, lon: 0, source: "IP Tracing (Fallback)" };

        const getNativeLocation = () => new Promise<{ lat: number, lon: number, source: string } | null>((resolve) => {
            if (!navigator.geolocation) return resolve(null);
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, source: "📍 GPS/Wi-Fi (High Accuracy)" }),
                (_err) => {
                    // console.log("[Geo] Failed:", err.message);
                    resolve(null);
                },
                { enableHighAccuracy: true, timeout: 5000 }
            );
        });

        const nativeLoc = await getNativeLocation();

        // C. IP Network Info (ISP, Region)
        let netInfo = { ip: "Unknown", org: "Unknown ISP", city: "Unknown", region: "" };
        try {
            const res = await fetch("https://ipapi.co/json/");
            if (res.ok) {
                const data = await res.json();
                netInfo = {
                    ip: data.ip,
                    org: data.org,
                    city: data.city,
                    region: data.region
                };
                // Use IP lat/lon only if Native Geo failed
                if (!nativeLoc) {
                    geo = { lat: data.latitude, lon: data.longitude, source: "🌐 IP Based (Approximate)" };
                } else {
                    geo = nativeLoc;
                }
            }
        } catch (e) { }

        // D. Reverse Geocoding (Convert Lat/Lon to Street Address)
        // Uses OpenStreetMap Nominatim (Free, No Key required)
        let detailedAddress = "";
        try {
            if (geo.lat !== 0 && geo.lon !== 0) {
                const reverseRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${geo.lat}&lon=${geo.lon}&zoom=18&addressdetails=1`, {
                    headers: { "User-Agent": "LiveVoiceKiosk/1.0" }
                });
                if (reverseRes.ok) {
                    const data = await reverseRes.json();
                    const addr = data.address;

                    // Construct hierarchy: Road -> Kelurahan -> Kecamatan -> Kota
                    const parts = [];
                    if (addr.road) parts.push(addr.road);
                    if (addr.village || addr.suburb) parts.push(addr.village || addr.suburb); // Kelurahan
                    if (addr.city_district || addr.county) parts.push(addr.city_district || addr.county); // Kecamatan
                    if (addr.city || addr.town) parts.push(addr.city || addr.town);
                    if (addr.state) parts.push(addr.state);

                    if (parts.length > 0) detailedAddress = parts.join(", ");
                }
            }
        } catch (e) {
            console.warn("Reverse geo failed", e);
        }

        // ---------------------------------------------------------
        // 2. CONSTRUCT PAYLOAD
        // ---------------------------------------------------------
        const timestamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const mapUrl = `https://www.google.com/maps?q=${geo.lat},${geo.lon}`;

        // 5. Advanced Web Fingerprinting
        const screen = window.screen;
        const orientType = (screen as any).orientation ? (screen as any).orientation.type : "Unknown";
        const orientAngle = (screen as any).orientation ? (screen as any).orientation.angle : 0;
        let screenDetail = `${screen.width}x${screen.height}`;

        // High-DPI / Retina Detection
        const dpr = window.devicePixelRatio || 1;
        if (dpr > 1) screenDetail += ` (@${dpr}x Scale)`;

        const touch = navigator.maxTouchPoints > 0 ? `Touch (${navigator.maxTouchPoints} pts)` : "No Touch";
        const lang = navigator.language;
        // const conn = (navigator as any).connection; 
        const rtt = conn ? `${conn.rtt}ms` : "?";

        // WebGL Vendor... (same)
        let gpuVendor = "";
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl');
            const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo && gl) {
                gpuVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
            }
        } catch (e) { }

        // Sync Electron Display Data if avail
        if (sysInfo.mac !== "Hidden (Web)") {
            // If we have Electron info, we might have better display data attached to sysInfo
            // (Requires ensuring sysInfo stored it. Let's update the interface reading above first)
            // Or just use window.screen which is accurate in Electron Renderer too.
            // But let's append "Kiosk Display" tag
            screenDetail += " [Native]";
        }

        const payload = {
            username: "Lemdiklat AI Monitor",
            avatar_url: "https://cdn-icons-png.flaticon.com/512/4712/4712035.png",
            embeds: [
                {
                    title: type === 'error' ? "⚠️ SYSTEM ALERT" : "🟢 SYSTEM STARTED",
                    description: `**Device**: ${sysInfo.device}\n**User**: ${sysInfo.user}\n**Status**: ${message}`,
                    color: type === 'error' ? 15158332 : 3066993,
                    thumbnail: { url: "https://cdn-icons-png.flaticon.com/512/3004/3004154.png" },
                    fields: [
                        // Row 1: Identity & Screen
                        { name: "👆 Input / Lang", value: `${touch}\n${lang.toUpperCase()}`, inline: true },
                        { name: "🖥️ Screen & Scale", value: `${screenDetail}\n${orientType} (${orientAngle}°)`, inline: true },

                        // Row 2: Peripherals
                        { name: "🎤 Mic / Speaker", value: `${audioDevices.mic}\n${audioDevices.speaker}`, inline: true },
                        { name: "🔋 Power / Uptime", value: `${batteryInfo}\nUp: ${sysUptime}`, inline: true },
                        { name: "🎮 GPU / Vendor", value: `${sysInfo.gpu.replace("ANGLE (", "").replace(")", "").substring(0, 20)}...\n(${gpuVendor})`, inline: true },

                        // Row 3: Specs
                        { name: "💻 Device / OS", value: `${sysInfo.device}\n${sysInfo.os}`, inline: true },
                        { name: "⚡ Core / RAM", value: `${sysInfo.cpu}\nRAM: ${sysInfo.ram}`, inline: true },
                        { name: "📶 IP / Ping", value: `${netInfo.ip}\n(${rtt})`, inline: true },

                        // Row 4: Loc & Time
                        { name: "📍 Locations", value: `[Link Map](${mapUrl})\n${detailedAddress || netInfo.city || "Unknown Location"}`, inline: true },
                        { name: "🕒 Local Time", value: timestamp, inline: true }
                    ],
                    footer: {
                        text: `Session ID: ${crypto.randomUUID().split('-')[0]} • Live Voice Kiosk`
                    }
                }
            ]
        };
        // console.log('[Discord] Sending webhook...'); // Silenced
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            // console.log('[Discord] Notification Sent!');
            lastNotificationTime = now;
        } else {
            // console.error('[Discord] Server responded with:', await res.text());
        }

    } catch (e) {
        // console.error("Failed to send Discord webhook", e);
    }
};
