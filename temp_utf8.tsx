/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality, Session } from "@google/genai";
import { LitElement, css, html } from "lit";
import { customElement, state, query } from "lit/decorators.js";

import { createBlob, decode, decodeAudioData } from "./utils";
import "./audio-waveform";
import { JakartaTimeUtils } from "./jakarta-time-utils";

import {
  LEMDIKLAT_AI_PROMPT,
} from "./ai-prompt";

// Web Speech API types
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
  | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any)
  | null;
  onerror:
  | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => any)
  | null;
  onend: ((this: SpeechRecognition, ev: Event) => any) | null;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

import { animate } from "motion";

@customElement("gdm-live-audio")
export class GdmLiveAudio extends LitElement {
  // Render in light DOM so Tailwind classes apply globally
  createRenderRoot() {
    return this;
  }
  @state() isRecording = false;
  @state() status = "";
  @state() error = "";
  // Store user's gain preference for Auto-Mute restore
  private savedGain: number = 0.7;
  // Gain default 0.7 (UI), efektif untuk mengurangi noise
  private gain = 0.7;
  @state() isVoiceCommandActive = false;
  @state() voiceCommandStatus =
    "≡ƒöç Voice command nonaktif, klik tombol untuk mengaktifkan";
  @state() isAudioUnlocked = false;
  // Suppress model speech during context preload to avoid looping
  private suppressModelSpeech: boolean = false;
  private isPreloadingContext: boolean = false;

  // Tempat/konten aktif
  @state() selectedPlace:
    | "Lemdiklat"
    | "Bandara"
    | "Gedung"
    | "Terminal"
    | "Stasiun"
    | "Garut"
    | "Maros"
    | "General" = "Lemdiklat";

  @state() private audioInputs: MediaDeviceInfo[] = [];
  @state() private selectedDeviceId: string = localStorage.getItem('selectedMicId') || '';

  // Gender suara AI
  // Gender suara AI (Default Male, Toggle non-aktif)
  @state() voiceGender: "male" | "female" = "male";

  // Conversation state for visual feedback
  @state() conversationState: 'idle' | 'listening' | 'processing' | 'speaking' | 'error' = 'idle';
  private lastVoiceActivityTime: number = 0; // For latency tracking
  private isUserSpeakingLog: boolean = false; // For console logging triggers

  // Responsive header state
  @state() isMobileHeaderActive = false;
  @state() headerCollisionDetected = false;

  @state()
  isInterrupted = false;

  private silenceTimer: number | null = null;

  @state()
  base64Image: string | null = null;
  // Track last interruption time to ignore stale audio packets
  private lastInterruptionTime: number = 0;

  // Prevent double-interruption triggers
  private isReconnecting = false;

  // Unique ID to prevent stale session messages (zombie audio)
  private currentSessionId: string = "";

  // Γ£à OPTIMIZATION: Audio Buffer for Instant Interruption
  // Stores audio chunks while session is reconnecting so no words are lost
  private pendingAudioBuffer: string[] = [];

  // -- VAD & RMS STATE --
  private vad: any = null;
  @state() isVadSpeaking: boolean = false;
  @state() vadProbability: number = 0;
  private speakingFrames = 0; // Robustness: Require consecutive frames > threshold

  // Hybrid Gate Threshold (0.04 = Short Range)
  speechVolumeThreshold: number = 0.1;
  @state() currentRms: number = 0;

  // Watchdog for AI Response Timeout
  private thinkingWatchdogTimer: number | null = null;
  private isThinkingTimerActive = false; // Track timer state to avoid warnings

  @query('#char-container') private charContainer!: HTMLDivElement;
  private currentAnimation?: any; // Changed from Animation to any to support Motion controls

  updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('conversationState')) {
      this.animateCharacter();
    }
  }

  private animateCharacter() {
    if (!this.charContainer) return;

    // Stop previous animation if needed
    if (this.currentAnimation && this.currentAnimation.stop) {
      this.currentAnimation.stop();
    }

    const element = this.charContainer;

    switch (this.conversationState) {
      case 'idle':
        // Gentle breathing
        this.currentAnimation = animate(
          element,
          {
            scale: [1, 1.02, 1],
            y: [0, -5, 0],
            filter: ["brightness(1)", "brightness(1.05)", "brightness(1)"]
          } as any,
          { duration: 4, easing: "ease-in-out", repeat: Infinity } as any
        );
        break;

      case 'listening':
        // Zoom in and hold attention
        this.currentAnimation = animate(
          element,
          {
            scale: 1.15,
            y: 0,
            filter: "brightness(1.1)"
          } as any,
          { duration: 0.5, easing: "spring" } as any // Fast reaction
        );
        break;

      case 'processing':
        // Zoomed in, swaying slightly
        this.currentAnimation = animate(
          element,
          {
            scale: 1.15,
            rotate: [0, -1, 1, 0],
            filter: "brightness(1.1) sepia(0.2)"
          } as any,
          { duration: 2, easing: "ease-in-out", repeat: Infinity } as any
        );
        break;

      case 'speaking':
        // Energetic bouncing while zoomed in
        this.currentAnimation = animate(
          element,
          {
            scale: [1.15, 1.18, 1.15],
            y: [0, -10, 0],
            filter: "brightness(1.2)"
          } as any,
          { duration: 0.8, easing: "ease-in-out", repeat: Infinity } as any
        );
        break;

      case 'error':
        this.currentAnimation = animate(
          element,
          {
            scale: 0.95,
            filter: ["grayscale(0)", "grayscale(1)"]
          } as any,
          { duration: 0.5 } as any
        );
        break;
    }
  }
  private client?: GoogleGenAI;
  private session?: Session;
  private sessionHandle?: string; // For session resumption
  private sessionActive = false;
  private isConnecting = false; // Prevent parallel connection attempts
  private inputAudioContext = new window.AudioContext({
    sampleRate: 16000,
  });
  private outputAudioContext = new window.AudioContext({
    sampleRate: 24000,
  });
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream?: MediaStream | null;
  private sourceNode?: MediaStreamAudioSourceNode | null;
  private scriptProcessorNode?: ScriptProcessorNode | AudioWorkletNode | null;
  private sources = new Set<AudioBufferSourceNode>();
  private speechRecognition?: SpeechRecognition | null;
  private isListeningForCommands = false;
  // Gating untuk mencegah loop: mute input saat model berbicara
  private isModelSpeaking = false;
  private speakingSources = 0;
  private wasListeningBeforePlayback = false;
  private lastTranscript: string = '';
  private lastTranscriptAt = 0;
  private maxSpeakingTimer: number | undefined;
  // Inactivity auto-shutdown & re-activation policy
  private requireVoiceStartAfterIdle = false;
  private inactivityTimer: number | undefined;
  private lastActivityAt = 0;
  private INACTIVITY_TIMEOUT_MS = 600000; // 10 Menit (Ultra Long Session)
  private autoReconnectEnabled = false; // matikan auto-reconnect; gunakan voice start
  private fileInputRef?: HTMLInputElement;
  private resizeObserver?: ResizeObserver;
  @state() startTriggeredByVoice = false;
  private _lastRmsUpdate = 0;
  private currentTurnComplete = false;

  // Kiosk Mode States
  @state() timeString = "";
  private timeInterval: number | undefined;

  // Computed property for state-based styling
  private get stateConfig() {
    switch (this.conversationState) {
      case 'listening':
        return {
          color: 'from-emerald-500 to-green-500',
          icon: '≡ƒÄñ',
          text: 'Listening...',
          glow: 'rgba(16, 185, 129, 0.4)'
        };
      case 'processing':
        return {
          color: 'from-amber-500 to-orange-500',
          icon: 'ΓÜÖ∩╕Å',
          text: 'Thinking...',
          glow: 'rgba(245, 158, 11, 0.4)'
        };
      case 'speaking':
        return {
          color: 'from-cyan-500 to-blue-500',
          icon: '≡ƒöè',
          text: 'Speaking...',
          glow: 'rgba(6, 182, 212, 0.4)'
        };
      case 'error':
        return {
          color: 'from-red-500 to-rose-500',
          icon: 'ΓÜá∩╕Å',
          text: 'Connection Lost',
          glow: 'rgba(239, 68, 68, 0.4)'
        };
      default:
        return null;
    }
  }

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      /* Background akan ditimpa secara dinamis via style attribute */
      background: #0b132b;
      position: relative;
    }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
    }

    .bg-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      opacity: 0.5;
      z-index: 5;
      pointer-events: none;
    }

    .place-switcher {
      position: absolute;
      top: 80px;
      right: 20px;
      z-index: 20;
      display: flex;
      gap: 8px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 12px;
      backdrop-filter: blur(10px);
    }

    .place-button {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: white;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-weight: 600;
    }

    .place-button:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .place-button.active {
      background: rgba(76, 175, 80, 0.25);
      border-color: rgba(76, 175, 80, 0.6);
      color: #b9ffb9;
    }

    .voice-gender-controls {
      position: absolute;
      top: 20px;
      right: 20px;
      z-index: 20;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 12px;
      backdrop-filter: blur(10px);
    }

    .voice-gender-button {
      outline: none;
      border: 1px solid rgba(255, 193, 7, 0.5);
      color: #ffc107;
      border-radius: 10px;
      background: rgba(255, 193, 7, 0.2);
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-weight: 600;
      white-space: nowrap;
    }

    .voice-gender-button:hover {
      background: rgba(255, 193, 7, 0.3);
    }

    .voice-gender-button.active {
      background: rgba(255, 193, 7, 0.4);
      border-color: rgba(255, 193, 7, 0.8);
    }

    /* Animated dots for PDF processing */
    @keyframes dotPulse {
      0% { transform: scale(1); opacity: .5; }
      50% { transform: scale(1.4); opacity: 1; }
      100% { transform: scale(1); opacity: .5; }
    }
    .dots .dot { animation: dotPulse 1s infinite; display: inline-block; }
    .dots .dot:nth-child(2) { animation-delay: .2s; }
    .dots .dot:nth-child(3) { animation-delay: .4s; }

    .overall-controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
    }

    .button-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }

    .sensitivity-controls {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 10px;
      color: white;
      padding: 10px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      margin-top: 20px;
    }

    .voice-command-status {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: white;
      padding: 15px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 15px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      backdrop-filter: blur(10px);
    }

    .voice-status-text {
      font-size: 14px;
      text-align: center;
      min-height: 20px;
      font-weight: 500;
    }

    .voice-status-indicator {
      font-size: 12px;
      font-weight: bold;
      padding: 8px 16px;
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid rgba(76, 175, 80, 0.5);
      border-radius: 8px;
      color: #4caf50;
      text-align: center;
    }

    .header-lemdiklat {
      position: absolute;
      top: 20px;
      left: 20px;
      z-index: 20;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(15px);
      border-radius: 20px;
      padding: 20px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      animation: slideInFromTop 0.8s ease-out;
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 15px;
    }

    .logo-icon {
      font-size: 48px;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3));
      animation: pulse 2s ease-in-out infinite;
    }

    .logo-text {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .main-title {
      font-size: 32px;
      font-weight: 900;
      color: #ffffff;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
      letter-spacing: 2px;
      font-family: "Arial Black", sans-serif;
      animation: glow 2s ease-in-out infinite;
    }

    .subtitle {
      font-size: 14px;
      color: #4caf50;
      font-weight: 600;
      letter-spacing: 1px;
      opacity: 0.9;
    }

    .version-info {
      font-size: 11px;
      color: #888;
      font-weight: 400;
      opacity: 0.7;
    }

    .header-details {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }

    .detail-item {
      font-size: 12px;
      color: #ffffff;
      opacity: 0.8;
      margin-bottom: 5px;
      text-align: center;
      font-weight: 500;
    }

    .voice-toggle-btn {
      outline: none;
      border: 1px solid rgba(255, 193, 7, 0.5);
      color: #ffc107;
      border-radius: 8px;
      background: rgba(255, 193, 7, 0.2);
      padding: 8px 16px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.3s ease;
      font-weight: 600;

      &:hover {
        background: rgba(255, 193, 7, 0.3);
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(255, 193, 7, 0.3);
      }

      &:active {
        transform: translateY(0);
      }
    }

    /* Animasi untuk header */
    @keyframes slideInFromTop {
      from {
        transform: translateY(-100px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    @keyframes pulse {
      0%,
      100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.1);
      }
    }

    @keyframes glow {
      from {
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5),
          0 0 10px rgba(255, 255, 255, 0.3);
      }
      to {
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5),
          0 0 20px rgba(255, 255, 255, 0.6), 0 0 30px rgba(76, 175, 80, 0.4);
      }
    }

    /* Character Animations - High Visibility Update */


    /* Custom scrollbar styles */
    .custom-scrollbar::-webkit-scrollbar {
      width: 6px;
    }

    .custom-scrollbar::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.3);
      border-radius: 3px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.5);
    }

    /* Firefox scrollbar */
    .custom-scrollbar {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.3) rgba(255, 255, 255, 0.1);
    }

    /* Mobile-specific styles and touch optimizations */
    @media (max-width: 640px) {
      /* Improve touch targets for mobile */
      .touch-manipulation {
        touch-action: manipulation;
        -webkit-tap-highlight-color: rgba(255, 255, 255, 0.1);
      }
      
      /* Larger touch targets for buttons */
      button {
        min-height: 44px;
        min-width: 44px;
      }
      
      /* Better spacing for mobile */
      .pdf-card-mobile {
        padding: 16px;
        margin-bottom: 12px;
      }
      
      /* Improved text readability on mobile */
      .mobile-text-base {
        font-size: 16px;
        line-height: 1.5;
      }
      
      .mobile-text-sm {
        font-size: 14px;
        line-height: 1.4;
      }
      
      /* Better contrast for mobile */
      .mobile-bg-enhanced {
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(12px);
      }
    }

    /* Tablet-specific optimizations */
    @media (min-width: 641px) and (max-width: 1024px) {
      .tablet-optimized {
        padding: 20px;
      }
      
      /* Better button spacing for tablet */
      .tablet-button-spacing {
        gap: 16px;
      }
    }

    /* Enhanced hover states for desktop */
    @media (hover: hover) and (pointer: fine) {
      .desktop-hover:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
      }
    }

    /* Prevent hover effects on touch devices */
    @media (hover: none) {
      .desktop-hover:hover {
        transform: none;
        box-shadow: none;
      }
      
      /* Enhanced active states for touch */
      .touch-active:active {
        transform: scale(0.98);
        background: rgba(255, 255, 255, 0.2);
      }
    }


  `;

  constructor() {
    super();
    // Pindahkan inisialisasi ke connectedCallback untuk resource management yang lebih baik
    // this.initClient(); 
    // this.initVoiceCommands();

    // Nonaktifkan voice command otomatis, aktifkan hanya via global click/UI
    this.isListeningForCommands = false;

    this.applyPlaceStyling();
    this.setupCollisionDetection();
  }

  private setupCollisionDetection() {
    // Setup ResizeObserver untuk mendeteksi perubahan ukuran window
    this.resizeObserver = new ResizeObserver(() => {
      this.checkHeaderCollision();
    });

    // Observe body element untuk perubahan ukuran
    this.resizeObserver.observe(document.body);

    // Initial check
    setTimeout(() => this.checkHeaderCollision(), 100);
  }

  private checkHeaderCollision() {
    // Gunakan breakpoint yang lebih tinggi untuk mobile detection
    if (window.innerWidth < 900) {
      this.isMobileHeaderActive = true;
      this.headerCollisionDetected = false;
      return;
    }

    const headerCard = document.querySelector('.header-card') as HTMLElement;
    const navigation = document.querySelector('.header-navigation') as HTMLElement;

    if (!headerCard || !navigation) {
      // Retry setelah DOM ready
      setTimeout(() => this.checkHeaderCollision(), 50);
      return;
    }

    const headerCardRect = headerCard.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const containerWidth = window.innerWidth - 48; // 24px padding kiri kanan

    // Hitung total lebar yang dibutuhkan dengan margin yang lebih besar
    const headerCardWidth = headerCardRect.width;
    const navigationWidth = navigationRect.width;
    const minGap = 60; // Margin yang lebih besar untuk mencegah collision
    const totalRequiredWidth = headerCardWidth + navigationWidth + minGap;

    // Deteksi collision berdasarkan total lebar yang dibutuhkan
    const collision = totalRequiredWidth > containerWidth;

    // Tambahan check untuk overlap langsung
    const directOverlap = (headerCardRect.right + minGap) > navigationRect.left;

    const shouldActivateMobile = collision || directOverlap || window.innerWidth < 1100;

    if (shouldActivateMobile !== this.isMobileHeaderActive) {
      this.headerCollisionDetected = collision || directOverlap;
      this.isMobileHeaderActive = shouldActivateMobile;
    }
  }

  async connectedCallback() {
    super.connectedCallback();

    // Inisialisasi resource di sini
    this.initClient();
    this.initVoiceCommands();

    // Setup cleanup on page reload/close
    window.addEventListener('beforeunload', this.handleBeforeUnload);

    // Start Clock
    this.updateTime();
    this.timeInterval = window.setInterval(() => this.updateTime(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // Cleanup listeners
    window.removeEventListener('beforeunload', this.handleBeforeUnload);

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.timeInterval) {
      clearInterval(this.timeInterval);
    }

    // Perform thorough cleanup
    this.cleanup();
  }

  private handleBeforeUnload = () => {
    this.cleanup();
  }

  private cleanup() {
    console.log("≡ƒº╣ Performing cleanup...");

    // 1. Stop Recording & Media Stream
    this.stopRecording(false);

    // 2. Close AI Session
    if (this.session) {
      try {
        this.session.close();
      } catch (e) { }
      this.session = undefined;
      this.sessionActive = false;
    }

    // 3. Stop Speech Recognition
    if (this.speechRecognition) {
      try {
        this.speechRecognition.abort(); // Abort is faster than stop
      } catch (e) { }
    }

    // 4. Close Audio Contexts explicitly to release hardware immediately
    // Penting untuk mencegah hanging saat reload
    if (this.inputAudioContext && this.inputAudioContext.state !== 'closed') {
      try { this.inputAudioContext.close(); } catch (e) { }
    }
    if (this.outputAudioContext && this.outputAudioContext.state !== 'closed') {
      try { this.outputAudioContext.close(); } catch (e) { }
    }

    // 5. Clear Timers
    this.stopInactivityTimer();
    this.stopThinkingWatchdog();
    if (this.maxSpeakingTimer) clearTimeout(this.maxSpeakingTimer);
  }

  private updateTime() {
    const now = new Date();
    this.timeString = now.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Jakarta',
      hour12: false
    }).replace(/\./g, ':'); // Format HH:MM:SS
    this.requestUpdate();
  }

  private handleGainChange(e: Event) {
    const target = e.target as HTMLInputElement;
    this.gain = parseFloat(target.value);
    if (this.inputNode) {
      // Scale gain by 1 to reduce sensitivity while keeping UI value standard
      this.inputNode.gain.value = this.gain * 1;
    }
  }

  private handleGlobalClick = (e: Event) => {
    // Ignore clicks on input elements
    if ((e.composedPath()[0] as HTMLElement).tagName === 'INPUT') return;

    // Don't trigger if clicking on interactive elements
    const path = e.composedPath();
    const isInteractive = path.some(el =>
      el instanceof HTMLElement &&
      (el.classList.contains('no-click-trigger') || el.closest('.no-click-trigger'))
    );

    if (isInteractive) return;

    // Resume Audio Contexts immediately (synchronous trigger for autoplay policy)
    // Using void catch to prevent unhandled promise rejection warnings
    if (this.inputAudioContext.state === 'suspended') {
      this.inputAudioContext.resume().catch(() => { });
    }
    if (this.outputAudioContext.state === 'suspended') {
      this.outputAudioContext.resume().catch(() => { });
    }

    this.isAudioUnlocked = true;

    // --- UX FIX: Instant Feedback ---
    // Show visual feedback immediately before heavy async work starts
    if (!this.isRecording) {
      this.updateStatus("Initializing...");
      // Force a micro-render to show status change
      this.requestUpdate();
    }

    // Run actual toggle logic in next frame to allow UI to update first
    requestAnimationFrame(() => {
      setTimeout(() => this.toggleRecording(), 0);
    });
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async getActivePrompt(): Promise<string> {
    // Khusus branch Lemdiklat: selalu gunakan prompt Lemdiklat
    let basePrompt = LEMDIKLAT_AI_PROMPT;

    // Inject real-time Jakarta timezone information for proper greetings
    const jakartaTimeInfo = JakartaTimeUtils.getDetailedTimeInfo();
    const timeContextPrompt = `\n\n=== INFORMASI WAKTU REAL-TIME ===\nWaktu Jakarta saat ini: ${jakartaTimeInfo.jakartaTime}\nJam: ${jakartaTimeInfo.hour} WIB\nPeriode waktu: ${jakartaTimeInfo.period}\nSalam yang tepat: "${jakartaTimeInfo.greeting}"\n\nPENTING: Gunakan informasi waktu Jakarta (WIB) di atas untuk memberikan salam yang tepat saat memulai percakapan atau menyapa pengguna. Jangan gunakan waktu sistem lokal atau UTC.`;

    basePrompt += timeContextPrompt;

    return basePrompt;
  }

  private getPlaceEmoji(): string {
    // Khusus Lemdiklat
    return "≡ƒÜö";
  }

  private getPlaceBackground(): string {
    // Khusus Lemdiklat
    return "url('/lemdiklar_expo.jpg')";
  }

  private getVoiceName(): string {
    // Available voices for native audio model: Aoede, Charon, Fenrir, Kore, Puck
    return this.voiceGender === "male" ? "Charon" : "Sulafat";
  }

  private toggleVoiceGender() {
    this.voiceGender = this.voiceGender === "male" ? "female" : "male";
    // Jika tidak sedang merekam, re-init session agar voice baru aktif
    if (!this.isRecording) {
      this.initSession();
    }
  }

  private applyPlaceStyling() {
    // Terapkan background ke host
    this.style.backgroundImage = this.getPlaceBackground();
    // Pastikan properti tambahan
    // @ts-ignore
    this.style.setProperty("background-repeat", "no-repeat");
    // @ts-ignore
    this.style.setProperty("background-size", "cover");
    // @ts-ignore
    this.style.setProperty("background-position", "center");
  }

  private selectPlace(
    place:
      | "Lemdiklat"
      | "Bandara"
      | "Gedung"
      | "Terminal"
      | "Stasiun"
      | "Garut"
      | "Maros"
      | "General"
  ) {
    if (this.selectedPlace === place) return;
    this.selectedPlace = place;
    this.applyPlaceStyling();
    // Jika tidak sedang merekam, re-init session agar prompt baru aktif
    if (!this.isRecording) {
      this.initSession();
    }
  }

  private async initClient() {
    try {
      this.initAudio();

      const apiKey = process.env.GEMINI_API_KEY || 'AIzaSyAZrbxtxIPjjzz0yniziwzUZTVPBB1EqJI';

      if (!apiKey) {
        throw new Error('API key tidak tersedia');
      }

      this.client = new GoogleGenAI({
        apiKey: apiKey,
      });

      this.outputNode.connect(this.outputAudioContext.destination);

      await this.initSession();
    } catch (error: any) {
      this.updateError(`Failed to initialize AI client: ${error.message || error}`);
    }
  }

  private initVoiceCommands() {
    // Check if browser supports Speech Recognition
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
      return;
    }

    // Initialize Speech Recognition
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    this.speechRecognition = new SpeechRecognition();

    this.speechRecognition.continuous = true;
    this.speechRecognition.interimResults = false;
    this.speechRecognition.lang = "id-ID"; // Indonesian language

    // Handle speech recognition results
    this.speechRecognition.onresult = async (event: SpeechRecognitionEvent) => {
      const rawTranscript = event.results[event.results.length - 1][0].transcript;
      const transcript = rawTranscript.toLowerCase();

      // Update transcript UI/Log
      this.voiceCommandStatus = `≡ƒùú∩╕Å "${rawTranscript}"`;
      console.log(`≡ƒùú∩╕Å [USER] Transcript: "${rawTranscript}"`);

      // Update aktivitas terakhir pada setiap hasil STT
      this.lastActivityAt = Date.now();

      if (transcript.includes("mulai pembicaraan") && !this.isRecording) {
        this.startTriggeredByVoice = true;
        // Izinkan re-aktivasi hanya melalui voice setelah idle
        this.requireVoiceStartAfterIdle = false;
        this.startRecording();
        this.voiceCommandStatus = "≡ƒÄñ Mulai pembicaraan terdeteksi!";
      } else if (transcript.includes("matikan pembicaraan")) {
        // "matikan pembicaraan" berarti mengakhiri pembicaraan dan recording
        this.voiceCommandStatus = "≡ƒ¢æ Pembicaraan dan recording diakhiri";

        // Kirim pesan ke AI untuk mengakhiri pembicaraan
        if (this.session && this.isRecording) {
          this.sendEndConversationMessage();
        }

        // Stop recording saja, voice command tetap aktif
        this.stopRecording();

        // Pastikan voice command tetap dalam status yang sama
        // Voice command tidak akan mati karena "matikan pembicaraan"
        this.voiceCommandStatus =
          "≡ƒÄº Voice command tetap aktif, siap untuk perintah baru";

        // Reset status pembicaraan
        setTimeout(() => {
          if (this.isListeningForCommands) {
            this.voiceCommandStatus =
              "≡ƒÄº Voice command aktif, siap untuk perintah baru";
          } else {
            this.voiceCommandStatus =
              "≡ƒöç Voice command nonaktif, klik tombol untuk mengaktifkan";
          }
        }, 3000);
      } else {
        // Bukan perintah kontrol ΓÇô gunakan teks sebagai pertanyaan untuk RAG
        try {
          // Jika model sedang berbicara, abaikan hasil STT untuk mencegah loop
          if (this.isModelSpeaking) return;
          // Abaikan teks yang terlalu pendek agar tidak membanjiri RAG
          const normalized = rawTranscript.trim();
          if (normalized.length < 5) return;
          // Deduplicate pertanyaan yang sama dalam jendela waktu singkat
          if (normalized === this.lastTranscript && (Date.now() - this.lastTranscriptAt) < 8000) {
            return;
          }
          this.lastTranscript = normalized;
          this.lastTranscriptAt = Date.now();

          // Google Search Grounding is enabled in the session config (tools: [{ googleSearch: {} }])
          // So we don't need to manually query a RAG server or send text context.
          // The model will use the audio input and search if needed.
          console.log("≡ƒöì [Grounding] Relying on Gemini + Google Search (RAG disabled)");

        } catch (e: any) {
          this.updateError(`Gagal mengambil konteks dokumen: ${e.message || e}`);
        }
      }
    };

    // Handle errors
    this.speechRecognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.voiceCommandStatus = `Error: ${event.error}`;
    };

    // Handle end of recognition
    this.speechRecognition.onend = () => {
      // Voice command hanya restart otomatis jika sedang aktif
      if (this.isListeningForCommands) {
        // Restart listening setelah delay singkat
        setTimeout(() => {
          this.startListeningForCommands();
        }, 100);
      }
    };

    // Voice command tidak langsung start, user harus aktifkan manual
  }

  // handleFirstGesture and unlockAudio removed to centralize logic in handleGlobalClick

  private startListeningForCommands() {
    if (!this.speechRecognition) return;

    try {
      this.speechRecognition.start();
      this.isListeningForCommands = true;
      this.voiceCommandStatus = "≡ƒÄº Mendengarkan perintah suara...";
    } catch (error) {
      this.voiceCommandStatus = "Error memulai voice command";
      // Jika gagal start, coba lagi setelah delay
      setTimeout(() => {
        if (this.isListeningForCommands) {
          this.startListeningForCommands();
        }
      }, 1000);
    }
  }

  private stopListeningForCommands() {
    if (!this.speechRecognition) return;

    try {
      this.speechRecognition.stop();
      // Tidak mengubah isListeningForCommands di sini
      // Status akan diatur oleh method yang memanggil
    } catch (error) {
      // Silent error handling for production
    }
  }

  private async initSession() {
    // Prevent parallel connection attempts
    if (this.isConnecting) {
      console.warn("ΓÜá∩╕Å [SESSION] Connection attempt ignored: Already connecting...");
      return;
    }
    this.isConnecting = true;

    try {
      // Tutup session yang ada jika masih aktif
      if (this.session) {
        try {
          this.session.close();
        } catch (e) {
          // Silent error handling for production
        }
        this.session = undefined;
        this.sessionActive = false;

        // Tunggu sebentar untuk memastikan session benar-benar tertutup
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const model = "gemini-2.5-flash-native-audio-preview-12-2025";

      // Get the active prompt asynchronously
      const activePrompt = await this.getActivePrompt();

      if (!this.client) {
        throw new Error("Google GenAI client not initialized");
      }

      // Generate unique ID for this session instance to prevent race conditions
      const sessionId = Date.now().toString();
      this.currentSessionId = sessionId;

      // Clear buffer only if it's a fresh start (not reconnecting mid-stream necessarily, 
      // but initSession usually means new connection). 
      // ACTUALLY: We want to KEEP it if we are reconnecting!
      // But if we are starting fresh from Idle, we might want to clear it.
      // logic: if restarting from idle, buffer should be empty anyway.
      // if reconnecting, we want to KEEP it. So don't clear here.
      // Only clear if explicitly requested or on error.

      this.session = await this.client.live.connect({
        model: model,
        config: {
          tools: [{ googleSearch: {} }],
          responseModalities: [Modality.AUDIO],
          // Enable context window compression for long conversations
          contextWindowCompression: {
            slidingWindow: {},
          },
          // Enable session resumption if a handle exists
          sessionResumption: this.sessionHandle ? {
            handle: this.sessionHandle,
          } : undefined,
          systemInstruction: {
            parts: [
              {
                text: activePrompt,
              },
            ],
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.getVoiceName(),
              },
            },
          },
        },
        callbacks: {
          onopen: async () => {
            if (this.currentSessionId !== sessionId) return; // Ignore if switched

            console.log("≡ƒîÉ [WEBSOCKET] Connection established");
            console.log("Γ£à Session opened successfully");
            this.sessionActive = true;
            this.isConnecting = false; // Reset connecting flag
            this.updateStatus("Session opened - Ready to record");
            // Mulai pemantauan inactivity
            this.startInactivityTimer();
            this.lastActivityAt = Date.now();

            // Trigger Initital Introduction
            // "Pancing" AI untuk bicara duluan dan menanyakan nama
            // Trigger Initital Introduction via Silent Audio
            // Text input via sendRealtimeInput is flaky, so we send 200ms of silence
            // to "wake up" the model and trigger the "Speak First" system prompt.

            // Reset Turn Complete flag
            this.currentTurnComplete = false;

            // Trigger Initital Introduction via Silent Audio
            // ALWAYS run this, even if resuming, to "wake up" the model if it was idle.
            // This fixes the issue where AI is silent after re-activation.
            setTimeout(() => {
              if (this.currentSessionId !== sessionId) return;

              try {
                // Generate 100ms of silence (reduced from 200ms for faster response)
                const sampleRate = 16000;
                const duration = 0.1;
                const numSamples = sampleRate * duration;
                // 16-bit = 2 bytes per sample
                const buffer = new ArrayBuffer(numSamples * 2);
                const view = new DataView(buffer);
                // Fill with zeros (silence)
                for (let i = 0; i < numSamples; i++) {
                  view.setInt16(i * 2, 0, true); // Little endian
                }

                // Convert to Base64
                const bytes = new Uint8Array(buffer);
                let binary = '';
                const len = bytes.byteLength;
                for (let i = 0; i < len; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                const base64Audio = window.btoa(binary);

                // --- SENDING AUDIO ---
                if (this.sessionActive && this.session) {
                  this.session.sendRealtimeInput({
                    audio: {
                      mimeType: "audio/pcm;rate=16000",
                      data: base64Audio // Use the base64 of the silent audio
                    }
                  });

                  if (Date.now() % 2000 < 20) { // Log roughly every 2 seconds
                    console.log(`≡ƒôñ [CLIENT] Sent audio chunk (${bytes.length} bytes)`);
                  }
                }
                console.log("≡ƒÜÇ Sent silent audio trigger to AI (Wake Up)");
              } catch (e) {
                console.error("ΓÜá∩╕Å Failed to send silent trigger:", e);
              }
            }, 100);

            // Γ£à FLUSH BUFFER: Send any audio recorded while connecting
            if (this.pendingAudioBuffer.length > 0 && this.session) {
              console.log(`≡ƒÜÇ [BUFFER] Flushing ${this.pendingAudioBuffer.length} queued audio chunks...`);
              // Send in sequence
              for (const chunk of this.pendingAudioBuffer) {
                this.session.sendRealtimeInput({
                  audio: {
                    mimeType: "audio/pcm;rate=16000",
                    data: chunk
                  }
                });
              }
              this.pendingAudioBuffer = [];
            }

            this.lastActivityAt = Date.now();
          },
          onmessage: async (message: LiveServerMessage) => {
            // Γ£à CRITICAL FIX: ZOMBIE SESSION CHECK
            // If this message belongs to a session ID that is no longer active, IGNORE IT.
            // This happens when we close a session (Stop) and start a new one (Start) quickly.
            // The old session's socket might still receive a final packet.
            if (this.currentSessionId !== sessionId) {
              // console.warn("≡ƒæ╗ [ZOMBIE] Ignoring message from stale session");
              return;
            }

            //  MONITORING LOGS
            // console.log("≡ƒôÑ [WEBSOCKET] Message received:", JSON.stringify(message).substring(0, 200));

            // Handle Session Resumption Update
            if ((message as any).sessionResumptionUpdate) {
              const update = (message as any).sessionResumptionUpdate;
              if (update.resumable && update.newHandle) {
                this.sessionHandle = update.newHandle;
                console.log("≡ƒöä [SESSION] Resumption handle updated:", this.sessionHandle?.substring(0, 10) + "...");
              }
            }

            if (message.serverContent?.turnComplete) {
              this.logEvent('GEMINI_MSG', 'Turn Complete');
              this.currentTurnComplete = true;

              // Only unmute if we are still recording and not in an error state
              if (this.isRecording && this.conversationState !== 'error') {
                // We don't force 'listening' here because audio playback might still be happening
                // The audio playback 'ended' event handles the transition to 'listening'
              }
            }

            // Γ£à WATCHDOG: Stop timer as soon as we get ANY response (Content or Audio)
            this.stopThinkingWatchdog();

            // If we receive audio, we are no longer 'processing' (thinking), so we can clear that state if needed
            // But usually we transition to 'speaking' when audio starts playing.

            if (this.conversationState === 'processing') {
              try { console.timeEnd("AI_Thinking_Duration"); } catch (e) { } // End thinking timer
            }

            if (message.serverContent?.interrupted) {
              this.logEvent('GEMINI_MSG', 'Interrupted Signal Received');
              // Stop all audio immediately
              this.sources.forEach(source => {
                try { source.stop(); } catch (e) { }
              });
              this.sources.clear();

              // Only reset to listening if we are not already in listening mode (user speaking)
              // to avoid overriding the state if user is already talking
              if (this.conversationState !== 'listening' && this.isRecording) {
                this.conversationState = 'listening';
                // Restore mic if needed, but check if we are actually recording
                this.setMicGain(1);
              }
            }

            const audio =
              message.serverContent?.modelTurn?.parts?.[0]?.inlineData;

            // Check for text content to detect schedule display triggers or just logging
            const textContent = message.serverContent?.modelTurn?.parts?.find(
              (part) => part.text
            )?.text;

            if (textContent) {
              // console.log(`≡ƒô¥ [GEMINI] Text Delta: "${textContent.substring(0, 50).replace(/\n/g, " ")}${textContent.length > 50 ? '...' : ''}"`);
              // Transition to speaking if we get text deltas to show we are getting SOMETHING
              // FIX: Do NOT switch to 'speaking' just for text. Wait for Audio.
              // This prevents the "Mouth moving but no sound" issue.
              if (this.conversationState === 'processing') {
                // Keep processing/thinking logic until audio arrives
              }
            }

            if (audio) {
              // Calculate and log latency if we have a valid last voice activity timestamp
              if (this.lastVoiceActivityTime > 0) {
                const latency = Date.now() - this.lastVoiceActivityTime;
                this.logEvent('LATENCY', `AI Response Latency: ${latency}ms`);
                // Reset timestamp so we only log latency for the START of the turn
                this.lastVoiceActivityTime = 0;
              }

              // AI is speaking
              // Guard: If we are not recording (stopped) or idle, do not play new audio
              // Guard: If we recently interrupted (within 1s), ignore potential stale audio
              if (!this.isRecording || this.conversationState === 'idle') {
                return;
              }

              // Γ£à FIX: Audio Blackout after Interruption
              if (this.isInterrupted) {
                this.logEvent('DROP_AUDIO', 'Blocking stale audio (Interruption Flag Active)');
                return;
              }

              if (Date.now() - this.lastInterruptionTime < 1000) {
                this.logEvent('DROP_AUDIO', 'Blocking stale audio (Interruption Cooldown)');
                return;
              }

              if (this.conversationState !== 'speaking') {
                this.logEvent('STATE_CHANGE', 'Transition to SPEAKING (Audio Received)');
              }

              this.conversationState = 'speaking';
              // Γ£à AGC: Disable Mic during AI Speech (No Voice Interrupt)
              // User request: "hilangkan interuptable by suara"
              this.setMicGain(0);

              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1
              );

              // --- LATENCY OPTIMIZATION ---
              // If buffer is very short, playing it immediately is fine.
              // But for stream continuity, ensure nextStartTime is not too far in future
              // Reset nextStartTime if it drifted too far (gap > 0.5s) to avoid perceived lag
              const currentTime = this.outputAudioContext.currentTime;
              if (this.nextStartTime < currentTime) {
                this.nextStartTime = currentTime;
              } else if (this.nextStartTime > currentTime + 0.5) {
                // Catch-up logic: if queue is too long, we might be lagging behind real-time
                // But usually we want to preserve audio.
                // Only skip if EXTREMELY behind (> 2s)? No, let's keep it safe.
              }

              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener("ended", () => {
                // Γ£à MEMORY LEAK FIX: Disconnect source to allow GC
                try { source.disconnect(); } catch (e) { }

                this.sources.delete(source);
                // If no more audio sources
                if (this.sources.size === 0) {
                  this.logEvent('STATE_CHANGE', 'Audio Finished (Natural End)');

                  // CASE: Natural Finish
                  // "ketika AI selesai berbicara akan masuk ke listening kembali"

                  if (this.isRecording) {
                    console.log("Γ£à [SESSION] AI finished speaking. Resuming listening.");

                    this.conversationState = 'listening';
                    this.updateStatus("Listening...");
                    // Γ£à AGC: Unmute Mic immediately
                    this.setMicGain(1);
                  }
                }
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error("Γ¥î Session error:", e);
            this.sessionActive = false;
            this.isConnecting = false; // Reset connecting flag

            // Only show error state if not playing audio
            if (this.sources.size === 0) {
              this.conversationState = 'error';
            }

            this.updateError(`Session error: ${e.message}`);

            // Jangan langsung reconnect pada error, tunggu user action
            if (this.isRecording) {
              this.stopRecording();
            }
            // Matikan pemantauan inactivity
            this.stopInactivityTimer();
          },
          onclose: (e: CloseEvent) => {
            console.log("≡ƒöî Session closed:", e.code, e.reason);
            this.sessionActive = false;

            // Only go to idle if audio has finished playing
            if (this.sources.size === 0) {
              this.conversationState = 'idle';
            }

            // Only show status update for abnormal closures
            if (e.code !== 1000) {
              this.updateStatus("Session closed: " + (e.reason || "Connection lost"));
            }
            // Jangan auto-reconnect; gunakan voice start
            this.stopInactivityTimer();
          },
        },
      });

    } catch (e: any) {
      this.isConnecting = false; // Reset connecting flag
      this.updateError(`Failed to initialize session: ${e.message || e}`);
      this.sessionActive = false;

      // Jika gagal init, stop recording untuk mencegah loop
      if (this.isRecording) {
        this.stopRecording();
      }
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  // --- EMERGENCY UNMUTE / INTERRUPTION CONTROL ---
  private handleEmergencyUnmute() {
    console.log("≡ƒ¢æ [USER] Manual Interruption / Unmute Triggered");

    // 1. Force State Reset
    this.conversationState = 'listening';
    this.updateStatus("Listening (Manual)...");

    // 2. Force Mic ON
    this.setMicGain(1);

    // 3. Reset VAD Internal State (Unstuck Logic)
    this.isVadSpeaking = false;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    // 4. Force Stop Audio Playback (Interruption)
    this.stopAudioPlayback();
  }

  private stopAudioPlayback() {
    if (this.sources.size > 0) {
      this.sources.forEach(source => {
        try {
          source.stop();
          source.disconnect(); // Γ£à Disconnect to ensure silence
        } catch (e) { }
      });
      this.sources.clear();

      // Γ£à FIX: Reset audio scheduling pointer
      // If we don't reset this, the next audio will be scheduled "after" the
      // cancelled audio would have finished, causing silence.
      this.nextStartTime = 0;
    }
  }

  // --- AUTOMATED GAIN CONTROL (AGC) ---
  // level: 0 = Mute, 1 = Active (Restore User Setting)
  private setMicGain(level: number) {
    if (!this.inputNode) return;

    // 1. SYNC UI SLIDER (Visual Feedback)
    if (level === 0) {
      // Muting: Save user preference then drop slider to 0
      if (this.gain > 0) this.savedGain = this.gain;
      this.gain = 0;
    } else {
      // Unmuting: Restore user preference (Slider jumps back up)
      if (this.savedGain > 0.1) {
        this.gain = this.savedGain;
      } else {
        this.gain = 0.7; // Default/Reset if stored val is weird
        this.savedGain = 0.7;
      }
    }

    // 2. APPLY TO AUDIO NODE
    // Target = (Current UI Gain) * (Scaling Factor 1)
    const targetValue = this.gain * 1;

    // Smooth transition to avoid clicking/popping
    const now = this.inputAudioContext.currentTime;
    try {
      this.inputNode.gain.cancelScheduledValues(now);
      this.inputNode.gain.setValueAtTime(this.inputNode.gain.value, now);
      this.inputNode.gain.linearRampToValueAtTime(targetValue, now + 0.1); // 100ms fade
      console.log(`≡ƒÄñ [AGC] Mic Gain set to ${level === 0 ? 'MUTE' : 'ACTIVE'} (UI: ${this.gain}, Node: ${targetValue.toFixed(2)})`);
    } catch (e) {
      // Fallback if ramping fails
      this.inputNode.gain.value = targetValue;
    }
  }

  // --- WATCHDOG SYSTEM (Auto-Refresh Stuck State) ---
  private startThinkingWatchdog() {
    this.stopThinkingWatchdog();
    this.thinkingWatchdogTimer = window.setTimeout(() => {
      // Only trigger if we are STILL stuck in processing
      // and we haven't received any response
      if (this.conversationState === 'processing') {
        console.warn("ΓÜá∩╕Å [WATCHDOG] AI Response Timeout (5s). Resetting...");
        if (this.isThinkingTimerActive) {
          try { console.timeEnd("AI_Thinking_Duration"); } catch (e) { }
          this.isThinkingTimerActive = false;
        }
        this.conversationState = 'listening';
        this.updateStatus("No response from AI. Listening...");
        this.setMicGain(1); // Force Unmute
        this.isVadSpeaking = false;
      }
    }, 5000); // 5 Seconds (User requested faster reset)
  }

  private stopThinkingWatchdog() {
    if (this.thinkingWatchdogTimer) {
      clearTimeout(this.thinkingWatchdogTimer);
      this.thinkingWatchdogTimer = null;
    }
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private async startRecording() {
    try {
      if (this.isRecording) {
        return;
      }

      // Track if user aborts during async operations
      let aborted = false;

      // 1. Immediate UI Feedback (Fixes "Clunky" feel)
      // Show "Listening" state immediately while getUserMedia loads
      this.conversationState = 'listening';
      this.updateStatus("Activating microphone...");

      // Γ£à RESET STATE: Ensure we start fresh
      this.isInterrupted = false;
      this.isReconnecting = false; // Fix: Ensure we are not stuck in "reconnecting" mode
      this.isRecording = true; // Γ£à FIX: Set early so onmessage doesn't block AI response
      this.isUserSpeakingLog = false; // Γ£à FIX: Reset VAD state
      this.speakingFrames = 0; // Γ£à FIX: Reset consecutive speaking frames

      // Γ£à FIX: Restore mic gain (might be muted from previous "processing" state)
      this.setMicGain(this.gain || 0.7);

      // Γ£à FORCE SILENCE: Stop any legacy audio before starting
      this.stopAudioPlayback();

      if (this.inputAudioContext.state === "suspended") {
        try {
          await this.inputAudioContext.resume();
        } catch (e) {
          this.updateError("AudioContext diblokir oleh kebijakan autoplay. Ketuk halaman untuk mengaktifkan audio.");
          return;
        }
      }

      // Pastikan output audio dapat berbicara tanpa menunggu gesture
      if (this.outputAudioContext.state === "suspended") {
        try {
          await this.outputAudioContext.resume();
        } catch (e) {
          // Beberapa browser memerlukan gesture untuk resume; lanjutkan tanpa error
        }
      }

      if (!this.sessionActive) {
        await this.initSession();

        // Race Condition Check: If user clicked stop (idle) during connection, abort immediately
        if (!this.isRecording && this.conversationState !== 'listening') {
          console.log("≡ƒ¢æ [START] Aborted: User stopped during connection.");
          aborted = true;
          this.stopRecording(false);
          return;
        }

        // Γ£à REMOVED WAIT LOOP: "Optimistic Recording"
        // We assume success and buffer audio if needed.
        /*
        let attempts = 0;
        while (!this.sessionActive && attempts < 40) { // Wait up to 2s
          await new Promise(resolve => setTimeout(resolve, 50));
          attempts++;
        }

        if (!this.sessionActive) {
          throw new Error("Session failed to initialize (Timeout)");
        }
        */
      }

      // --- DIAGNOSTIC: List Audio Devices (Disabled for Production) ---
      /*
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        console.log("≡ƒÄñ Available Audio Inputs:", audioInputs.map(d => d.label || 'Unknown Device'));
        if (audioInputs.length === 0) {
          console.warn("ΓÜá∩╕Å No audio inputs detected!");
        }
      } catch (e) {
        console.error("Γ¥î Failed to enumerate devices:", e);
      }
      */
      // --------------------------------------

      this.updateStatus("Requesting microphone access...");

      // --- SMART DEVICE SELECTION ---
      let targetDeviceId = this.selectedDeviceId;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.audioInputs = devices.filter(d => d.kind === 'audioinput');
        // console.log("≡ƒÄñ Available Audio Inputs:", this.audioInputs.map(d => `[${d.deviceId.substring(0, 5)}] ${d.label}`));

        if (!targetDeviceId) {
          // Priority: Realtek > Microphone Array > Anything NOT Oculus/Virtual
          const preferred = this.audioInputs.find(d =>
            d.label.toLowerCase().includes('realtek') ||
            d.label.toLowerCase().includes('microphone array')
          );

          if (preferred) {
            // console.log(`≡ƒÄ» Found preferred microphone: "${preferred.label}"`);
            targetDeviceId = preferred.deviceId;
          } else {
            const nonVirtual = this.audioInputs.find(d =>
              !d.label.toLowerCase().includes('oculus') &&
              !d.label.toLowerCase().includes('virtual')
            );
            if (nonVirtual) {
              // console.log(`≡ƒÄ» Falling back to non-virtual microphone: "${nonVirtual.label}"`);
              targetDeviceId = nonVirtual.deviceId;
            }
          }
        }
      } catch (e) {
        console.error("Γ¥î Failed to select smart microphone:", e);
      }
      // -------------------------------

      this.updateStatus("Accessing microphone...");

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });

      // Race Check: If user stopped during getUserMedia
      if (aborted || (!this.isRecording && this.conversationState !== 'listening')) {
        console.log("≡ƒ¢æ [START] Aborted: User stopped during microphone access.");
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
        this.stopRecording(false);
        return;
      }

      // --- DIAGNOSTIC: Monitor Raw Audio Levels (DISABLED - Too noisy) ---
      // Commented out to reduce console spam
      /*
      const audioContext = this.inputAudioContext;
      const analyzer = audioContext.createAnalyser();
      const diagnosticSource = audioContext.createMediaStreamSource(this.mediaStream);
      diagnosticSource.connect(analyzer);
      analyzer.fftSize = 256;
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);

      const checkLevel = () => {
        if (!this.isRecording) return;
        analyzer.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((src, val) => src + val, 0) / dataArray.length;
        if (Date.now() % 500 < 50) {
          console.log(`≡ƒôè [RAW MIC LEVEL] Average: ${average.toFixed(2)} (Target > 0)`);
        }
        requestAnimationFrame(checkLevel);
      };
      checkLevel();
      */
      // --------------------------------------------

      // --- DIAGNOSTIC: Inspect MediaStream Tracks (Disabled) ---
      // this.mediaStream.getTracks().forEach(track => {
      //   console.log(`≡ƒÄñ Track: "${track.label}" | Active: ${track.enabled} | Muted (by system): ${track.muted} | State: ${track.readyState}`);
      // });
      // ----------------------------------------------

      this.updateStatus("Microphone access granted. Starting capture...");
      // Note: isRecording is already set to true earlier to allow AI response
      // before getUserMedia completes

      // Ensure Inactivity Timer is restarted (especially if reusing session)
      this.startInactivityTimer();
      this.lastActivityAt = Date.now();

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);

      // Apply gain to the audio input with scaling factor (1.0 UI = 1 Actual)
      this.inputNode.gain.value = this.gain * 1;
      this.sourceNode.connect(this.inputNode);

      // Γ£à AGC: Ensure Mic is Unmuted on Start
      this.setMicGain(1);

      // Initialize AI VAD (Enabled in Dev & Prod via Local Assets)

      // Load the AudioWorklet module
      try {
        const workletPath = 'worklets/audio-processor.js';
        const workletUrl = new URL(workletPath, window.location.href).href;
        await this.inputAudioContext.audioWorklet.addModule(workletUrl);
        // console.log("Γ£à AudioWorklet module loaded successfully from:", workletUrl);
      } catch (e) {
        console.error("Γ¥î Failed to load AudioWorklet:", e);
        this.updateError("Gagal memuat modul audio. Coba refresh halaman.");
        return;
      }

      this.scriptProcessorNode = new AudioWorkletNode(this.inputAudioContext, 'audio-processor');

      // Handle messages from the processor (Audio Data + RMS)
      this.scriptProcessorNode.port.onmessage = (event) => {
        if (!this.isRecording) return;

        // Γ¢ö GATE REMOVED: Allow input processing even when AI is speaking (Barge-in / Interruptibility)
        // Echo Cancellation (AEC) in getUserMedia should handle the feedback loop.

        const { audioData, rms } = event.data;
        const pcmData = audioData; // Float32Array

        // --- PERFORMANCE: Log removed for production ---
        // -----------------------------------------------

        // Simple Noise Gate
        // Calculate dB relative to 100 (approximate SPL mapping where 0dBFS = 100dB)
        // 0.002 RMS ~= 46 dB. User requested 55 dB threshold.
        const db = rms > 0 ? (20 * Math.log10(rms) + 100) : 0;

        // --- PERFORMANCE FIX: Throttle UI Updates ---
        // Updating @state currentRms every 16ms causes massive re-renders/lag
        // Only update every ~60ms (15fps) for smoother UI
        const now = Date.now();
        // Use a static/class property for tracking (mocked here by checking difference or simply throttle)
        // Since we are in an arrow function closure, we can't easily add a new class property without full refactor.
        // We will use a simple timestamp attached to 'this' via 'any' or just rely on significant change.

        // Better: Use Date.now() check
        if (!this._lastRmsUpdate) this._lastRmsUpdate = 0;

        if (now - this._lastRmsUpdate > 60 || Math.abs(rms - this.currentRms) > 0.1) {
          this.currentRms = rms;
          this._lastRmsUpdate = now;
        }

        // --- ROBUST VAD LOGIC ---
        // Require 3 consecutive frames (~48ms) above 55dB to qualify as speech
        if (db >= 65) {
          this.speakingFrames++;
        } else {
          this.speakingFrames = 0;
        }

        // Only process audio if we are genuinely speaking (or trailing off)
        const isSpeaking = this.speakingFrames > 3 || this.isUserSpeakingLog;

        if (!isSpeaking) {
          pcmData.fill(0); // Mute the block

          // If we WERE speaking but now silent (and speakingFrames reset), trigger silence logic
          // VAD Logic: Silence Detected
          // If we were speaking, start a timer to confirm "End of Speech" avoiding choppy triggers
          if (this.isUserSpeakingLog) {
            if (!this.silenceTimer) {
              // Start a 500ms debounce timer (Snappy response)
              this.silenceTimer = window.setTimeout(() => {
                console.log("≡ƒñ½ [CLIENT] Silence Confirmed (Debounced) - User stopped speaking.");
                this.isUserSpeakingLog = false;
                this.silenceTimer = null;

                // Trigger "Thinking" state
                // Guard: Only if AI is not already speaking or Idle
                if (this.conversationState !== 'speaking' && this.conversationState !== 'idle') {
                  this.conversationState = 'processing';

                  // Clean up old timer if exists
                  if (this.isThinkingTimerActive) {
                    try { console.timeEnd("AI_Thinking_Duration"); } catch (e) { }
                  }

                  console.time("AI_Thinking_Duration"); // Start thinking timer
                  this.isThinkingTimerActive = true;

                  this.updateStatus("Thinking...");
                  // Γ£à AGC: Mute Mic during processing to prevent noise triggers
                  this.setMicGain(0);

                  // Γ£à WATCHDOG: Start timer to force reset if AI dies
                  this.startThinkingWatchdog();

                  // Γ£à FORCE TURN END: Tell server we are done speaking so it generates response immediately
                  // This prevents the server from waiting for more audio and triggering the watchdog
                  if (this.session && this.sessionActive) {
                    try {
                      // Fix: Send empty array instead of undefined for turns
                      this.session.sendClientContent({ turnComplete: true, turns: [] });
                      console.log("Γ£à [CLIENT] Sent turnComplete signal to AI");
                    } catch (e) {
                      console.warn("Failed to send turnComplete:", e);
                    }
                  }
                }
              }, 800);
            }
          }
        } else {
          // VAD Logic: Voice Detected
          // Cancel any pending silence timer because user is still speaking
          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }

          // User is speaking (above threshold)
          // ANTI-ECHO GUARD: Only update activity timestamp if AI is NOT speaking
          // This prevents AI's own voice from being registered as user activity for latency metrics
          if (this.conversationState !== 'speaking' && !this.isModelSpeaking) {
            this.lastVoiceActivityTime = Date.now();
          }

          // Log state change to Speaking
          if (!this.isUserSpeakingLog) {
            console.log(`≡ƒÄñ [CLIENT] Voice detected (> 65dB) - Sending valid audio stream (RMS: ${rms.toFixed(4)} | dB: ${Math.floor(db)})`);
            this.isUserSpeakingLog = true;

            // Γ£à RESET INTERRUPTION FLAG: User has spoken, so we are ready for new AI response
            this.isInterrupted = false;

            // Safety: Force turn complete after 60 seconds of continuous speech (anti-stuck)
            if (this.maxSpeakingTimer) clearTimeout(this.maxSpeakingTimer);
            this.maxSpeakingTimer = window.setTimeout(() => {
              if (this.isUserSpeakingLog) {
                console.warn("ΓÜá∩╕Å [CLIENT] Max speaking duration exceeded (60s). Forcing turn complete.");
                // Reset VAD state locally to force silence logic on next frame
                this.speakingFrames = 0;
                this.isUserSpeakingLog = false; // Will trigger silence logic in next loop if signal drops, but here we force send

                if (this.session && this.sessionActive) {
                  this.session.sendClientContent({ turnComplete: true, turns: [] });
                  this.conversationState = 'processing';
                  this.updateStatus("Thinking (Max Duration)...");
                }
              }
            }, 60000);
          }
        }

        if (this.isRecording) { // Allow buffering even if sessionActive is false
          try {
            // Convert Float32Array to proper format for native audio model
            const audioBlob = createBlob(pcmData);

            if (this.session && this.sessionActive) {
              // Normal case: Send directly
              this.session.sendRealtimeInput({
                audio: {
                  data: audioBlob.data,
                  mimeType: audioBlob.mimeType,
                },
              });
            } else {
              // Γ£à BUFFERING: Session reconnecting/connecting
              // Store audio to send later
              if (this.pendingAudioBuffer.length < 500 && audioBlob.data) { // Limit buffer size & check data
                this.pendingAudioBuffer.push(audioBlob.data);
              }
            }
          } catch (error) {
            // Jika terjadi error, tandai session tidak aktif dan coba reconnect
            this.sessionActive = false;
            this.updateError(`Audio transmission error: ${(error as any).message || error}`);
            setTimeout(() => {
              if (this.isRecording) {
                this.initSession();
              }
            }, 1000);
          }
        }
      };

      this.inputNode.connect(this.scriptProcessorNode);
      // Worklet nodes don't strictly require connection to destination if they don't produce output for playback,
      // but connecting it ensures the graph is active.
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      // this.isRecording = true; // Moved up
      this.conversationState = 'listening';
      this.updateStatus("≡ƒö┤ Recording... Listening for voice.");
      this.lastActivityAt = Date.now();

      // Jika start dipicu oleh voice command, kirim sapaan awal agar AI langsung berbicara
      if (this.startTriggeredByVoice && this.session && this.sessionActive) {
        try {
          const jakartaTimeInfo = JakartaTimeUtils.getDetailedTimeInfo();
          const greet = `Mulai percakapan: Sapa pengguna dengan salam yang sesuai waktu Jakarta (WIB), misalnya "${jakartaTimeInfo.greeting}". Perkenalkan diri singkat dan tanyakan bagaimana bisa membantu. Jangan menunggu input audio.`;
          this.session.sendClientContent({
            turns: [greet],
            turnComplete: true,
          });
        } catch (e) {
          // Abaikan jika gagal, percakapan tetap berjalan
        } finally {
          this.startTriggeredByVoice = false;
        }
      }

      // Voice command tetap dalam status yang sama (aktif atau nonaktif)
      // Tidak otomatis mengaktifkan voice command
    } catch (error: any) {
      this.updateError(`Failed to start recording: ${error.message || error}`);
      this.isRecording = false;

      // Clean up any partially initialized resources
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => track.stop());
        this.mediaStream = null;
      }
    }
  }

  private stopRecording(keepSessionAlive = false) {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus(keepSessionAlive ? "Pausing microphone..." : "Resetting...");

    // Γ£à SOFT RESET: Full state cleanup without page reload (Electron compatible)
    console.log("≡ƒº╣ [SESSION] Soft reset - clearing all state...");

    // 1. Stop all timers
    this.stopInactivityTimer();
    this.stopThinkingWatchdog();
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.maxSpeakingTimer) {
      clearTimeout(this.maxSpeakingTimer);
      this.maxSpeakingTimer = undefined;
    }

    // 2. Stop all audio playback
    this.stopAudioPlayback();

    // 3. Reset state flags
    this.isRecording = false;
    this.conversationState = 'idle';
    this.isUserSpeakingLog = false;
    this.isInterrupted = false;
    this.isReconnecting = false;
    this.isConnecting = false;
    this.sessionActive = false;
    this.isModelSpeaking = false;
    this.speakingFrames = 0;
    this.currentTurnComplete = false;

    // 4. Clear buffers and handles
    this.pendingAudioBuffer = [];
    this.sessionHandle = undefined;
    this.currentSessionId = "";
    this.lastInterruptionTime = 0;
    this.lastVoiceActivityTime = 0;
    this.lastActivityAt = 0;
    this.nextStartTime = 0;

    // 5. Disconnect audio nodes
    if (this.scriptProcessorNode) {
      try { this.scriptProcessorNode.disconnect(); } catch (e) { }
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) { }
      this.sourceNode = null;
    }

    // 6. Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // 7. Close WebSocket session
    if (this.session) {
      try { this.session.close(); } catch (e) { }
      this.session = undefined;
    }

    // 8. Reset gain to default
    try {
      this.inputNode.gain.value = this.gain || 0.7;
    } catch (e) { }

    console.log("Γ£à [SESSION] Soft reset complete - Ready for fresh start");
    this.updateStatus("Ready");
    // If fully stopping, go to idle. If pausing, maybe stay in a 'paused' state?
    // For now, idle is fine, but sessionActive remains true.
    this.conversationState = 'idle';

    this.updateStatus(keepSessionAlive ? "Microphone paused." : "Recording stopped.");
    // Hentikan pemantauan inactivity
    this.stopInactivityTimer();

    // PENTING: Method ini TIDAK mengubah status voice command
    // Voice command tetap dalam status yang sama (aktif/nonaktif)
    // Hanya recording yang dihentikan
  }



  private refreshSession() {
    // Stop recording jika sedang aktif
    if (this.isRecording) {
      this.stopRecording();
    }

    // Close existing session
    if (this.session) {
      this.session.close();
      this.session = undefined;
    }

    // Reset states
    this.sessionActive = false;

    this.error = "";
    this.status = "Disconnected";

    // Clear audio sources
    this.sources.forEach(source => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Ignore errors when stopping sources
      }
    });
    this.sources.clear();

    // Reset audio timing
    this.nextStartTime = 0;

    // Initialize new session
    this.initSession();
    this.updateStatus("Session refreshed - Ready to connect");
  }

  // Γ£à HARD INTERRUPT: Close and Resume Session
  private async reconnectSession() {
    console.log("ΓÜí [INTERRUPT] Executing Hard Interrupt (Close & Reconnect)...");
    this.updateStatus("Interrupting...");

    // 1. Stop Audio & Mute
    this.stopAudioPlayback();
    // Keep mic muted during reconnection to prevent noise
    // this.setMicGain(0); 

    // 2. Close Session
    if (this.session) {
      try {
        this.session.close();
      } catch (e) { }
      this.session = undefined;
      this.sessionActive = false;
    }

    // 3. Wait for cleanup (safety buffer)
    await new Promise(r => setTimeout(r, 100));

    // 4. Re-Initialize (Uses sessionHandle for resumption)
    // Don't await strictly for UI update, but we need it for logic
    // We let it run in background/parallel while we set UI to listening
    this.initSession();

    // Γ£à INSTANT UI: Set to Listening IMMEDIATELY
    // We rely on 'pendingAudioBuffer' to catch any speech while connecting
    this.conversationState = 'listening';
    this.updateStatus("Listening...");

    // 6. Unmute Cleanly
    this.setMicGain(1);
    this.isInterrupted = false;
  }

  // --- STATE MACHINE & FLOW CONTROL ---
  // Vision:
  // 1. Idle -> Click -> Listening (Init Session)
  // 2. Listening -> Click -> Idle (Stop/Cancel)
  // 3. Speaking -> Natural Finish -> Idle (Close Session)
  // 4. Speaking -> Click (Interrupt) -> Listening (Stop Audio, Ready for Next Input)

  // Profiling Helper
  private logEvent(event: string, details?: any) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    console.log(`ΓÅ▒∩╕Å [${timestamp}] [${event}]`, details || '');
  }

  private toggleRecording() {
    this.logEvent('USER_ACTION', 'Global Click Detected');

    // CASE 1: INTERRUPT (AI is Speaking OR Thinking/Processing)
    if (this.conversationState === 'speaking' || this.conversationState === 'processing' || (this.outputAudioContext && this.sources.size > 0)) {
      this.logEvent('INTERRUPT', 'User Interrupted AI -> Executing Hard Reset');

      // Γ£à FLAG: Mark as interrupted
      this.isInterrupted = true;
      this.lastInterruptionTime = Date.now();

      // Stop thinking timer if active
      if (this.isThinkingTimerActive) {
        try { console.timeEnd("AI_Thinking_Duration"); } catch (e) { }
        this.isThinkingTimerActive = false;
      }

      // Γ£à HARD INTERRUPT STRATEGY
      // Close connection and reconnect to guarantee audio stop and clean state
      this.reconnectSession();

      return;
    }

    // CASE 2: STOP (User is Listening/Recording)
    if (this.isRecording) {
      this.logEvent('USER_ACTION', 'Stop Recording -> Going to Idle');

      // User manually stopped while listening
      // This is a "Cancel" or "Manual Stop" action
      this.stopListeningForCommands();
      this.stopRecording(false); // false = Close Session (Clean Slate)
      return;
    }

    // CASE 3: START (Idle)
    // User wants to start a new session
    this.logEvent('USER_ACTION', 'Start Recording -> Initializing');

    if (this.requireVoiceStartAfterIdle) {
      this.updateStatus("Aktifkan kembali dengan ucapkan 'mulai pembicaraan'");
      return;
    }

    this.startRecording();
    this.startListeningForCommands();
  }

  private sendEndConversationMessage() {
    // Kirim pesan "matikan pembicaraan" ke AI untuk memicu respons terima kasih
    if (this.session && this.isRecording) {
      // Buat audio sederhana yang merepresentasikan kata kunci
      const sampleRate = 16000;
      const duration = 0.5; // 0.5 detik
      const samples = new Float32Array(sampleRate * duration);

      // Generate tone sederhana sebagai sinyal
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.1; // 440Hz tone
      }

      const audioBlob = createBlob(samples);
      this.session.sendRealtimeInput({
        audio: {
          data: audioBlob.data,
          mimeType: audioBlob.mimeType,
        },
      });
    }
  }

  // Inactivity monitor helpers
  private startInactivityTimer() {
    this.stopInactivityTimer();
    this.inactivityTimer = window.setInterval(() => {
      if (!this.sessionActive || !this.isRecording) return;
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.INACTIVITY_TIMEOUT_MS) {
        this.updateStatus("Tidak ada percakapan, menutup sesi otomatis (idle)");
        // Setelah idle shutdown, minta voice start untuk re-aktivasi
        this.requireVoiceStartAfterIdle = true;
        // Gunakan true untuk keepSessionAlive agar konteks tidak hilang saat idle
        this.stopRecording(true);
      }
    }, 10000); // cek setiap 10 detik
  }

  private stopInactivityTimer() {
    if (this.inactivityTimer) {
      window.clearInterval(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
  }






  // --- UI RENDER HELPERS ---

  // --- UI RENDER HELPERS ---

  renderEmergencyButton() {
    // Show whenever we are NOT idle (Connecting, Listening, Processing, Speaking)
    if (this.conversationState === 'idle') return null;

    const isMuted = this.gain < 0.01;

    return html`
      <button
        @click=${(e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleEmergencyUnmute();
      }}
        title="${isMuted ? "Unmute & Interrupt" : "Mic is Active"}"
        class="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-xl transition-all hover:scale-110 active:scale-95 ${isMuted ? 'bg-red-500 animate-pulse' : 'bg-blue-500'}"
        style="box-shadow: 0 0 20px ${isMuted ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)'}"
      >
        ${isMuted ? html`
            <!-- Muted Icon -->
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-white"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
        ` : html`
            <!-- Active Icon -->
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-white"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
        `}
      </button>
    `;
  }

  renderVadMonitor() {
    if (!this.vad) return null;

    const barColor = this.vadProbability > 0.8 ? '#4ade80' : '#ef4444';
    const widthPct = Math.min(100, Math.max(0, this.vadProbability * 100));

    // Bottom-right panel (Stacked above button)
    return html`
      <div class="fixed bottom-24 right-6 z-50 w-72 bg-black/90 backdrop-blur text-white p-4 rounded-xl border border-white/10 shadow-2xl font-mono text-xs">
        <div class="flex justify-between items-center mb-2 pb-2 border-b border-white/10">
            <span class="font-bold text-emerald-400">AI VAD MONITOR</span>
            <span class="text-white/40">Silero v5</span>
        </div>

        <div class="flex justify-between mb-1">
            <span>STATUS:</span>
            <span class="${this.isVadSpeaking ? 'text-emerald-400 font-bold' : 'text-gray-500'}">
                ${this.isVadSpeaking ? "≡ƒùú∩╕Å SPEAKING" : "≡ƒñ½ SILENCE"}
            </span>
        </div>

        <div class="flex justify-between mb-2 text-white/50">
            <span>Confidence:</span>
            <span>${this.vadProbability.toFixed(3)}</span>
        </div>

        <!-- VAD BAR -->
        <div class="w-full h-3 bg-white/10 rounded-full overflow-hidden relative mb-4">
            <!-- Threshold 0.8 -->
            <div class="absolute top-0 bottom-0 left-[80%] w-0.5 bg-yellow-400/50 z-10" title="Threshold"></div>
            <div class="h-full transition-all duration-75 ease-out ${this.vadProbability > 0.8 ? 'bg-emerald-500' : 'bg-red-500'}" style="width: ${widthPct}%"></div>
        </div>

        <!-- VOLUME BAR -->
        <div class="flex justify-between mb-1 text-white/50">
            <span>Volume (RMS):</span>
            <span>${this.currentRms.toFixed(3)}</span>
        </div>
        <div class="w-full h-3 bg-white/10 rounded-full overflow-hidden relative">
            <!-- 55dB Noise Gate Threshold (approx 0.0056 RMS) relative to 0.2 RMS scale -->
            <!-- 0.0056 / 0.2 = 2.8% -->
            <div class="absolute top-0 bottom-0 left-[2.8%] w-0.5 bg-red-500/80 z-20" title="Noise Gate (55dB)"></div>
            
            <!-- Close Range Threshold -->
            <div class="absolute top-0 bottom-0 left-[${Math.min(100, (this.speechVolumeThreshold / 0.2) * 100)}%] w-0.5 bg-cyan-400/80 z-10" title="Vol Threshold"></div>
            <div class="h-full bg-blue-500 transition-all duration-75" style="width: ${Math.min(100, (this.currentRms / 0.2) * 100)}%"></div>
        </div>
        <div class="mt-2 text-[10px] text-white/40 text-center">
            Garis Merah = Noise Gate (55dB)<br>
            Bar Biru > Garis Cyan = Close Range
        </div>
      </div>
    `;
  }

  renderMicSelector() {
    if (this.audioInputs.length === 0) return null;

    return html`
      <div class="fixed bottom-6 left-6 z-50 no-click-trigger flex flex-col gap-3">
        <!-- Main Controls Panel -->
        <div class="bg-black/60 backdrop-blur-xl border border-white/10 p-4 rounded-2xl shadow-2xl flex flex-col gap-4 w-72 transition-all hover:bg-black/80">
          
          <!-- Mic Selection Section -->
          <div class="flex flex-col gap-2">
            <label class="text-[10px] text-white/40 font-bold uppercase tracking-wider px-1 flex justify-between">
              <span>Audio Input</span>
              <span class="text-emerald-500/50">Online</span>
            </label>
            <div class="relative group">
              <select 
                @change=${(e: any) => {
        this.selectedDeviceId = e.target.value;
        localStorage.setItem('selectedMicId', this.selectedDeviceId);
        if (this.isRecording) {
          this.stopRecording(true);
          setTimeout(() => this.startRecording(), 300);
        }
      }}
                class="w-full bg-zinc-900/50 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white outline-none cursor-pointer focus:border-emerald-500 transition-all appearance-none pr-10"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22white%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1em top 50%; background-size: .65em auto;"
              >
                ${this.audioInputs.map(mic => html`
                  <option value="${mic.deviceId}" ?selected=${this.selectedDeviceId === mic.deviceId} style="background: #18181b; color: white;">
                    ${mic.label || 'Default Microphone'}
                  </option>
                `)}
              </select>
            </div>
          </div>

          <!-- Sensitivity Section -->
          <div class="flex flex-col gap-2 pt-2 border-t border-white/5">
                 <div class="flex justify-between items-center px-1">
                    <label class="text-[10px] text-white/40 font-bold uppercase tracking-wider">Mic Sensitivity</label>
                    <span class="text-[10px] text-emerald-400 font-mono">${this.gain.toFixed(1)}</span>
                 </div>
                 <div class="flex items-center gap-3">
                    <span class="text-[10px] text-white/20">Min</span>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      .value=${this.gain}
                      @input=${this.handleGainChange}
                      class="flex-1 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-black [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:bg-emerald-300 transition-all"
                    >
                    <span class="text-[10px] text-white/20">Max</span>
                 </div>
          </div>

        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div
        class="min-h-screen w-full bg-cover bg-center relative cursor-pointer overflow-hidden"
        style="background-image: url('./general.jpg');"
        @click=${this.handleGlobalClick}
      >
        <!-- Overlay untuk meredupkan background -->
        <div class="absolute inset-0 bg-black/60 pointer-events-none"></div>

        <!-- Ambient Recording Glow -->
        <div
          class="absolute inset-0 pointer-events-none transition-all duration-1000 ease-in-out z-10"
          style="box-shadow: ${this.stateConfig ? `inset 0 0 100px ${this.stateConfig.glow}` : 'none'}; opacity: ${this.stateConfig ? '1' : '0'};"
        ></div>

        <!-- HEADER: LEMDIKLAT BRANDING (Top Left) -->
        <div class="fixed top-6 left-6 z-50 pointer-events-none">
          <div class="bg-black/40 backdrop-blur-md border border-white/10 rounded-full px-5 py-2 flex items-center gap-3 shadow-lg">
            <div class="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-sm shadow-inner">
              ${this.getPlaceEmoji()}
            </div>
            <div>
              <div class="text-sm font-bold text-white tracking-wide leading-none">LEMDIKLAT</div>
              <div class="text-[10px] text-emerald-400 font-medium leading-none mt-0.5">Live Voice Agent</div>
            </div>
          </div>
        </div>

        <!-- CLOCK (Top Right) -->
        <div class="fixed top-8 right-8 z-50 flex flex-col items-end pointer-events-none">
          <div class="text-2xl font-bold text-white/80 tracking-widest drop-shadow-md font-mono">
            ${this.timeString}
          </div>
        </div>

        <!-- VISUAL STATE INDICATOR (Top Center) -->
        ${this.stateConfig ? html`
          <div class="fixed top-8 left-1/2 -translate-x-1/2 z-50 pointer-events-none animate-fadeIn">
            <div class="px-6 py-2 rounded-full flex items-center gap-3 backdrop-blur-md border border-white/10 bg-black/30 shadow-lg transition-all duration-300">
              <span class="text-xl ${this.conversationState === 'processing' ? 'animate-spin' : this.conversationState === 'listening' ? 'animate-pulse' : ''}">${this.stateConfig.icon}</span>
              <span class="text-white/90 font-medium text-sm tracking-wide">${this.stateConfig.text}</span>
            </div>
          </div>
        ` : ''}

        <!-- AI CHARACTER (Bottom Center) -->
        <div class="absolute bottom-[-8vh] left-1/2 -translate-x-1/2 z-20 pointer-events-none w-full max-w-4xl flex justify-center items-end">
             <!-- Character Wrapper (Shrink-Wrapped & Animated) -->

             <div id="char-container" class="relative inline-flex justify-center" style="transform-origin: bottom center;">
                <img
                  src="./char-lemdiklat.webp"
                  alt="AI Character"
                  class="max-h-[94vh] w-auto h-auto object-contain drop-shadow-[0_0_50px_rgba(0,0,0,0.5)] relative z-20"
                />

                <!-- ALIVE WAVEFORM (Mouth Area) -->
                <!-- Positioned specifically for the Cyber Police robotic faceplate -->
                <!-- Removed mix-blend-screen to ensure visibility on light mask -->
                <div class="absolute top-[19.5%] left-1/2 -translate-x-1/2 w-[7%] h-[40px] z-50 flex items-center justify-center opacity-100">
                    <gdm-live-audio-waveform
                      .inputNode=${this.inputNode}
                      .outputNode=${this.outputNode}
                      .mode=${'mouth'}
                      class="w-full h-full"
                    ></gdm-live-audio-waveform>
                </div>
             </div>
        </div>

        <!-- Mic Selector & Sensitivity Controls (Bottom Left - Stacked) -->
        ${this.renderMicSelector()}
        
        <!-- Status & Error Messages (Bottom) -->
        ${this.error ? html`
          <div class="fixed bottom-20 left-1/2 -translate-x-1/2 bg-red-900/80 text-white px-6 py-2 rounded-full backdrop-blur-md border border-red-500/50 z-40 text-sm shadow-lg animate-bounce">
            ΓÜá∩╕Å ${this.error}
          </div>
        ` : ''}

        <!-- Footer Info (Bottom Right) -->
        <div class="fixed bottom-4 right-4 z-30 pointer-events-none opacity-50">
          <div class="flex items-center gap-2 text-[10px] text-white/60">
            <div class="w-1.5 h-1.5 rounded-full ${this.sessionActive ? 'bg-green-500' : 'bg-red-500'}"></div>
            <span>v1.0 ΓÇó PT.IKB</span>
          </div>
        </div>

        ${this.renderEmergencyButton()}
        ${this.renderVadMonitor()}
      </div>
    `;
  }
}
