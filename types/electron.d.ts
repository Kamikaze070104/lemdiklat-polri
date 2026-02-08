
// Extend Window interface for Electron Bridge
declare global {
    interface Window {
        electronAPI?: {
            getSystemInfo: () => Promise<{
                hostname: string;
                platform: string;
                release: string; // OS version
                type: string; // 'Windows_NT' etc
                distro?: string; // e.g. "Fedora Linux 39"
                arch: string;
                cpus: string; // CPU Model
                totalmem: number;
                userInfo: string; // Username
                mac: string;
                localIp: string;
                uptime: number;
                loadAvg: number[];
                display: {
                    width: number;
                    height: number;
                    scale: number;
                    touch: boolean;
                };
            }>;
        };
    }
}
