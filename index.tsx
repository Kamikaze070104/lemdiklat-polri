/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { LitElement, css, html } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { animate } from "motion";

import { createBlob, decode, decodeAudioData } from './utils';
import './audio-waveform';
import { JakartaTimeUtils } from './jakarta-time-utils';
import { LEMDIKLAT_AI_PROMPT } from './ai-prompt';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() isRecording = false;
  @state() status = 'Tap anywhere to start';
  @state() error = '';

  // Conversation state
  @state() conversationState: 'idle' | 'listening' | 'speaking' | 'error' = 'idle';

  // UI States
  @state() isMobileHeaderActive = false;
  @state() headerCollisionDetected = false;
  @state() timeString = "";
  @state() voiceGender: "male";
  @state() selectedPlace: "Lemdiklat" | "Bandara" | "Gedung" | "Terminal" | "Stasiun" | "Garut" | "Maros" | "General" = "Lemdiklat";

  // Audio & AI
  private client: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;

  private inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  @state() private audioInputs: MediaDeviceInfo[] = [];
  @state() private selectedDeviceId: string = localStorage.getItem('selectedMicId') || '';

  // Interruption Logic
  private isAiTurn = false; // Tracks if we are expecting or playing AI audio
  private ignoreIncomingAudio = false; // Flag to discard chunks after interruption

  // Animation
  @query('#char-container') private charContainer!: HTMLDivElement;
  private currentAnimation?: any;
  private resizeObserver?: ResizeObserver;
  private timeInterval: number | undefined;

  // -- Styles --
  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      background: #0b132b;
      position: relative;
    }
  `;

  constructor() {
    super();
    this.initClient();
    this.updateTime();
  }

  connectedCallback() {
    super.connectedCallback();
    this.timeInterval = window.setInterval(() => this.updateTime(), 1000);
    this.setupCollisionDetection();
    this.enumerateDevices();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timeInterval) clearInterval(this.timeInterval);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.stopRecording();
  }

  updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('conversationState')) {
      this.animateCharacter();
    }
  }

  // --- Logic Implementation ---

  private async enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter(d => d.kind === 'audioinput');
      // If no selected device, pick the first one
      if (!this.selectedDeviceId && this.audioInputs.length > 0) {
        this.selectedDeviceId = this.audioInputs[0].deviceId;
      }
    } catch (e) {
      console.error("Failed to enumerate devices", e);
    }
  }

  private async initClient() {
    this.nextStartTime = this.outputAudioContext.currentTime;
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        this.updateError("API Key not found. Please check your .env file.");
        return;
      }
      this.client = new GoogleGenAI({
        apiKey: apiKey,
      });
      this.outputNode.connect(this.outputAudioContext.destination);
      this.initSession();
    } catch (e) {
      this.updateError("Failed to initialize AI Client");
    }
  }

  private async initSession() {
    const modelName = 'gemini-2.5-flash-native-audio-preview-12-2025';

    try {
      this.sessionPromise = this.client.live.connect({
        model: modelName,
        callbacks: {
          onopen: () => {
            this.updateStatus(this.isRecording ? 'Listening...' : 'Tap anywhere to start');
            if (this.isRecording) this.conversationState = 'listening';
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio data
            const base64EncodedAudioString = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64EncodedAudioString) {
              // Discard audio if we are interrupted OR if we are currently recording (User speaking)
              if (this.ignoreIncomingAudio) return;

              // AI is speaking
              this.conversationState = 'speaking';
              this.isAiTurn = true; // Mark as AI turn

              this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);

              const audioBuffer = await decodeAudioData(
                decode(base64EncodedAudioString),
                this.outputAudioContext,
                24000,
                1,
              );

              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
                if (this.sources.size === 0) {
                  // Audio finished
                  if (this.isRecording) {
                    this.conversationState = 'listening';
                    this.updateStatus("Listening...");
                    this.isAiTurn = false; // Turn over (mostly)
                  } else {
                    this.conversationState = 'idle';
                    this.updateStatus('Tap anywhere to start');
                  }// Keep isAiTurn true if we expect more chunks? 
                  // Usually we don't know. But if clicked, we force false.
                  // Let's rely on 'turnComplete' if available, otherwise assume done when audio done.
                  // *Correction*: To allow seamless interruption, we keep isAiTurn true until explicitly stopped or new input?
                  // No, if audio stops naturally, turn is over.

                  // BUT, network jitter might cause empty buffer then new chunk.
                  // We'll set it to false after a short timeout? Or rely on 'turnComplete'.
                  // For now, let's keep it simple: Audio end -> Turn end (Visual only).
                  // Logic relies on 'speaking' state for interruption mostly.
                  this.isAiTurn = false;
                }
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            // Handle interruption
            if (message.serverContent?.interrupted) {
              this.stopAllPlayback();
              this.isAiTurn = false;
              this.ignoreIncomingAudio = false; // Reset flag to allow new response
              if (this.isRecording) {
                this.updateStatus("Listening...");
              }
            }

            if (message.serverContent?.turnComplete) {
              this.isAiTurn = false;
              this.ignoreIncomingAudio = false; // Reset on turn complete
            }
          },
          onerror: (e: any) => {
            console.error("Session Error:", e);
            this.updateError('Connection error. Tap to retry.');
            this.conversationState = 'error';
            this.isRecording = false;
            this.isAiTurn = false;
          },
          onclose: (e: CloseEvent) => {
            console.log("Session closed:", e.reason);
            this.updateStatus('Session closed. Tap to restart.');
            this.conversationState = 'idle';
            this.isRecording = false;
            this.sessionPromise = null;
            this.isAiTurn = false;
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
          },
          systemInstruction: LEMDIKLAT_AI_PROMPT,
          tools: [{ googleSearch: {} }],
        },
      });
      await this.sessionPromise;
    } catch (e) {
      console.error(e);
      this.updateError('Failed to initialize session.');
      this.sessionPromise = null;
    }
  }

  private stopAllPlayback() {
    for (const source of this.sources.values()) {
      try { source.stop(); } catch (e) { }
      this.sources.delete(source);
    }
    this.nextStartTime = this.outputAudioContext.currentTime;
    this.isAiTurn = false;
  }

  private async handleGlobalClick(e: Event) {
    if ((e.composedPath()[0] as HTMLElement).tagName === 'INPUT' || (e.composedPath()[0] as HTMLElement).tagName === 'SELECT') return;
    const path = e.composedPath();
    const isInteractive = path.some(el =>
      el instanceof HTMLElement &&
      (el.classList.contains('no-click-trigger') || el.closest('.no-click-trigger'))
    );
    if (isInteractive) return;

    // Check if AI is currently speaking OR if we consider it "AI's Turn" (to handle audio gaps)
    if (this.sources.size > 0 || this.conversationState === 'speaking' || this.isAiTurn) {
      // Interruption Logic: Stop speaking, go directly to Listening
      console.log("Interrupting AI");
      this.ignoreIncomingAudio = true; // Discard any pending chunks
      this.stopAllPlayback();
      this.isAiTurn = false;
      // Requirement: "Harusnya kembali ke listening" -> Start Recording immediately
      await this.startRecording();
      return;
    }
    // If "Thinking" (Processing), likely allow interrupt too?
    // User requested: "global clicked untuk interupt".
    // If status is "Thinking", maybe click should cancel?
    // Currently, stopRecording() sets status to "Thinking" (or Idle/Ready in previous fix).
    // Let's assume Thinking is part of AI turn.

    if (this.isRecording) {
      // Logic: Listening -> Thinking (Stop & Send)
      this.stopRecording();
      this.isAiTurn = true; // We expect AI to reply now
    } else {
      // Logic: Idle -> Listening (Start)
      await this.startRecording();
    }
  }

  private async startRecording() {
    if (this.isRecording) return;

    this.conversationState = 'listening';
    this.isAiTurn = false; // User turn
    // We assume any audio arriving NOW is old until we stop recording?
    // Yes, because full duplex is not the goal here.
    // So ignoreIncomingAudio must stay true until we get the interrupted signal!
    // this.ignoreIncomingAudio = false; // REMOVED: Don't reset here, wait for signal.

    if (this.inputAudioContext.state === 'suspended') await this.inputAudioContext.resume();
    if (this.outputAudioContext.state === 'suspended') await this.outputAudioContext.resume();

    if (!this.sessionPromise) {
      await this.initSession();
    }

    this.updateStatus('Requesting Microphone...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.selectedDeviceId ? { exact: this.selectedDeviceId } : undefined
        }
      });
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.sessionPromise) return;

        // Auto-Mute: Logic to prevent echo/interruption when AI is speaking
        if (this.conversationState === 'speaking' || this.isAiTurn) {
          return;
        }

        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({ media: createBlob(inputData) });
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('Listening...');
      this.updateError('');

      this.stopAllPlayback();

    } catch (err: any) {
      console.error('Error starting recording:', err);
      this.updateError(`Microphone Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    this.isRecording = false;
    this.conversationState = 'idle';
    this.updateStatus('Tap anywhere to start');
    // Let's keep it subtle or just Idle.
    // If we set isAiTurn = true, maybe we show nothing or a subtle spinner?
    // For now, minimal.

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  // --- UI Helpers ---

  private updateStatus(msg: string) { this.status = msg; }
  private updateError(msg: string) { this.error = msg; }

  private updateTime() {
    const now = new Date();
    this.timeString = now.toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Jakarta', hour12: false
    }).replace(/\./g, ':');
    this.requestUpdate();
  }

  private getPlaceEmoji(): string { return "🚔"; }

  private get stateConfig() {
    switch (this.conversationState) {
      case 'listening': return {
        color: 'bg-black/60 border-white/20',
        icon: '👂',
        text: 'Listening...',
        textColor: 'text-white'
      };
      case 'speaking': return {
        // Updated to match "Speaking" UI request: Brighter Cyan, solid gradient feel?
        // Using a gradient border or background
        color: 'bg-gradient-to-r from-black/80 to-cyan-900/30 border-cyan-500/50 shadow-[0_0_15px_rgba(6,182,212,0.3)]',
        icon: '🔊',
        text: 'Speaking... (Mic Muted)',
        textColor: 'text-cyan-400 font-bold drop-shadow-[0_0_5px_rgba(34,211,238,0.8)]'
      };
      case 'idle': return null;
      case 'error': return {
        color: 'bg-red-900/80 border-red-500',
        icon: '⚠️',
        text: 'Error',
        textColor: 'text-white'
      };
      default: return null;
    }
  }

  private setupCollisionDetection() {
    this.resizeObserver = new ResizeObserver(() => {
      if (window.innerWidth < 900) this.isMobileHeaderActive = true;
    });
    this.resizeObserver.observe(document.body);
  }

  private animateCharacter() {
    if (!this.charContainer) return;
    if (this.currentAnimation && this.currentAnimation.stop) this.currentAnimation.stop();

    const element = this.charContainer;

    switch (this.conversationState) {
      case 'idle':
        this.currentAnimation = animate(element, { scale: [1, 1.02, 1], y: [0, -5, 0], filter: ["brightness(1)", "brightness(1.05)", "brightness(1)"] } as any, { duration: 4, easing: "ease-in-out", repeat: Infinity } as any);
        break;
      case 'listening':
        this.currentAnimation = animate(element, { scale: 1.15, y: 0, filter: "brightness(1.1)" } as any, { duration: 0.5, easing: "spring" } as any);
        break;
      case 'speaking':
        this.currentAnimation = animate(element, { scale: [1.15, 1.18, 1.15], y: [0, -10, 0], filter: "brightness(1.2)" } as any, { duration: 0.8, easing: "ease-in-out", repeat: Infinity } as any);
        break;
      case 'error':
        this.currentAnimation = animate(element, { scale: 0.95, filter: ["grayscale(0)", "grayscale(1)"] } as any, { duration: 0.5 } as any);
        break;
      default:
        this.currentAnimation = animate(element, { scale: 1.05, filter: "brightness(1)" } as any, { duration: 1 } as any);
    }
  }

  renderMicSelector() {
    if (this.audioInputs.length === 0) return null;

    return html`
      <div class="fixed bottom-6 left-6 z-50 no-click-trigger flex flex-col gap-3">
        <div class="bg-black/60 backdrop-blur-xl border border-white/10 p-4 rounded-2xl shadow-2xl flex flex-col gap-4 w-72 transition-all hover:bg-black/80">
          <div class="flex flex-col gap-2">
            <label class="text-[10px] text-white/40 font-bold uppercase tracking-wider px-1 flex justify-between">
              <span>Audio Input</span>
              <span class="${this.conversationState === 'speaking' || this.isAiTurn ? 'text-red-500/80 animate-pulse' : 'text-emerald-500/50'}">
                ${this.conversationState === 'speaking' || this.isAiTurn ? 'MUTED (AI Speaking)' : 'Online'}
              </span>
            </label>
            <div class="relative group">
              <select 
                @change=${(e: any) => {
        this.selectedDeviceId = e.target.value;
        localStorage.setItem('selectedMicId', this.selectedDeviceId);
        if (this.isRecording) {
          this.stopRecording();
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
        <!-- Overlay -->
        <div class="absolute inset-0 bg-black/60 pointer-events-none"></div>

        <!-- Ambient Glow (Status Based) -->
        <div
          class="absolute inset-0 pointer-events-none transition-all duration-1000 ease-in-out z-10"
          style="box-shadow: ${this.stateConfig && this.stateConfig.icon !== '⚠️' ? `inset 0 0 100px ${this.conversationState === 'speaking' ? 'rgba(6,182,212,0.3)' : 'rgba(16,185,129,0.3)'}` : 'none'}; opacity: ${this.stateConfig ? '1' : '0'};"
        ></div>

        <!-- Header -->
        <div class="fixed top-6 left-6 z-50 pointer-events-none">
          <div class="bg-black/40 backdrop-blur-md border border-white/10 rounded-full px-5 py-2 flex items-center gap-3 shadow-lg">
            <div class="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-sm shadow-inner">
              ${this.getPlaceEmoji()}
            </div>
            <div>
              <div class="text-sm font-bold text-white tracking-wide leading-none">LEMDIKLAT</div>
              <div class="text-[10px] text-emerald-400 font-medium leading-none mt-0.5">Live Voice Agents</div>
            </div>
          </div>
        </div>

        <!-- Clock -->
        <div class="fixed top-8 right-8 z-50 flex flex-col items-end pointer-events-none">
          <div class="text-2xl font-bold text-white/80 tracking-widest drop-shadow-md font-mono">
            ${this.timeString}
          </div>
        </div>

         <!-- Visual State Indicator (Refined Pill Style) -->
        ${this.stateConfig ? html`
          <div class="fixed top-8 left-1/2 -translate-x-1/2 z-50 pointer-events-none animate-fadeIn">
            <!-- Dark Pill Style matching image -->
            <div class="px-6 py-2 rounded-full flex items-center gap-3 backdrop-blur-md border ${this.stateConfig.color} shadow-lg transition-all duration-300">
               <!-- Icon Container -->
               <div class="w-6 h-6 flex items-center justify-center">
                   ${this.conversationState === 'listening' ? html`
                        <!-- Mic Icon -->
                       <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-white animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                   ` : html`
                        <span class="text-lg">${this.stateConfig.icon}</span>
                   `}
               </div>
              <span class="${this.stateConfig.textColor} font-medium text-sm tracking-wide">${this.stateConfig.text}</span>
            </div>
          </div>
        ` : ''}

        <!-- Error Msg -->
        ${this.error ? html`
          <div class="fixed bottom-20 left-1/2 -translate-x-1/2 bg-red-900/80 text-white px-6 py-2 rounded-full backdrop-blur-md border border-red-500/50 z-40 text-sm shadow-lg animate-bounce">
            ⚠️ ${this.error}
          </div>
        ` : ''}
        
        <!-- Status Guide -->
        ${!this.isRecording && this.conversationState !== 'speaking' ? html`
            <div class="fixed bottom-32 left-1/2 -translate-x-1/2 z-40 text-white/50 text-xs text-center pointer-events-none">
                 ${this.status}
            </div>
        ` : ''}

        <!-- Character Container -->
        <div class="absolute bottom-[-9vh] left-1/2 -translate-x-1/2 z-20 pointer-events-none w-full max-w-4xl flex justify-center items-end">
             <div id="char-container" class="relative inline-flex justify-center" style="transform-origin: bottom center;">
                <img
                  src="./char-lemdiklat.webp"
                  alt="AI Character"
                  class="max-h-[90vh] w-auto h-auto object-contain drop-shadow-[0_0_50px_rgba(0,0,0,0.5)] relative z-20"
                />
                
                <!-- Mouth Waveform -->
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

         <!-- Mic Selector (Restored) -->
         ${this.renderMicSelector()}

         <!-- Footer -->
         <div class="fixed bottom-4 right-4 z-30 pointer-events-none opacity-50">
          <div class="flex items-center gap-2 text-[10px] text-white/60">
            <div class="w-1.5 h-1.5 rounded-full ${this.sessionPromise ? 'bg-green-500' : 'bg-red-500'}"></div>
             <!-- Blue Mic Icon -->
              <span class="bg-blue-500 p-2 rounded-full text-white ml-2 opacity-100 shadow-lg shadow-blue-500/50">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
             </span>
             <span>v1.0 PT.IKB</span>
          </div>
        </div>

      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio': GdmLiveAudio;
  }
}
