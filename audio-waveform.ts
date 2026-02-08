/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Analyser } from "./analyser";

@customElement("gdm-live-audio-waveform")
export class GdmLiveAudioWaveform extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private animationId: number | null = null;
  private dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }

  get outputNode() {
    return this._outputNode;
  }

  private _outputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }

  get inputNode() {
    return this._inputNode;
  }

  private _inputNode!: AudioNode;

  @property({ type: String })
  mode: 'full' | 'mouth' = 'full';

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      position: absolute;
      inset: 0;
      background: transparent;
      z-index: 0;
      pointer-events: none;
    }

    canvas {
      width: 100% !important;
      height: 100% !important;
      display: block;
      background: transparent;
      pointer-events: none;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
  }

  private init() {
    this.ctx = this.canvas.getContext("2d")!;
    // Scale context for crisp rendering on high-DPI screens
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.startAnimationLoop();
  }

  private startAnimationLoop() {
    this.animationId = requestAnimationFrame(() => this.startAnimationLoop());

    this.inputAnalyser.update();
    this.outputAnalyser.update();

    this.drawWaveform();
  }

  private drawWaveform() {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    // Responsive sizing
    const base = Math.min(width, height);
    const radius = 60; // Just for reference, not drawn
    const margin = Math.max(24, Math.min(base * 0.1, 48));

    // Use almost full width for the spectrum line
    const leftX = width * 0.1;
    const rightX = width * 0.9;

    const centerY = Math.max(
      radius + margin,
      Math.min(height * 0.45, height - radius - margin)
    );

    // Draw connecting line between waveforms (now the main visual)
    if (this.mode === 'mouth') {
      this.drawMouthSpectrum(width, height);
    } else {
      this.drawConnectionLine(leftX, rightX, centerY, radius);
    }
  }

  private drawMouthSpectrum(width: number, height: number) {
    const ctx = this.ctx;
    const data = this.outputAnalyser ? this.outputAnalyser.data : new Uint8Array(0);
    if (data.length === 0) return;

    // Config
    const barCount = 5; // Number of bars per side
    const barWidth = (width / 2) / (barCount + 2);
    const gap = 2;
    const center = width / 2;
    const maxBarHeight = height * 0.8;

    // Style
    ctx.fillStyle = "#000000ff";
    ctx.shadowBlur = 15;
    ctx.shadowColor = "#000000ff";

    // Draw bars mirrored from center
    for (let i = 0; i < barCount; i++) {
      // Use low-frequency bins (they have more energy usually)
      // Map i (0..4) to index (0..8) roughly
      const index = Math.floor((i / barCount) * (data.length / 2));
      const value = data[index] || 0;

      // Normalize 0-1
      const percent = value / 255;
      const barHeight = Math.max(4, percent * maxBarHeight);

      const xOffset = (i * (barWidth + gap)) + gap;

      // Right side
      ctx.fillRect(center + xOffset, (height - barHeight) / 2, barWidth, barHeight);

      // Left side
      ctx.fillRect(center - xOffset - barWidth, (height - barHeight) / 2, barWidth, barHeight);
    }
  }

  // Circular waveform drawing method removed as requested

  private drawConnectionLine(startX: number, endX: number, y: number, radius: number) {
    // Draw dynamic audio waveform connection
    this.ctx.save();

    const connectionStartX = startX + Math.max(40, radius * 0.4);
    const connectionEndX = endX - Math.max(40, radius * 0.4);
    const connectionWidth = connectionEndX - connectionStartX;

    // Get audio data for waveform
    const inputData = this.inputAnalyser.data;
    const outputData = this.outputAnalyser.data;

    // Calculate average amplitude from both input and output
    const inputAvg = inputData.reduce((sum, val) => sum + val, 0) / inputData.length;
    const outputAvg = outputData.reduce((sum, val) => sum + val, 0) / outputData.length;
    const combinedAmplitude = (inputAvg + outputAvg) / 2;

    // Normalize amplitude (0-255 to 0-1)
    const normalizedAmplitude = combinedAmplitude / 255;

    // Number of waveform points
    const waveformPoints = 60;
    const pointSpacing = connectionWidth / (waveformPoints - 1);

    // Create gradient for the waveform
    const gradient = this.ctx.createLinearGradient(connectionStartX, 0, connectionEndX, 0);
    gradient.addColorStop(0, "#ff6b6b");
    gradient.addColorStop(0.5, "#ffffff");
    gradient.addColorStop(1, "#4ecdc4");

    this.ctx.strokeStyle = gradient;
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    // Draw the waveform
    this.ctx.beginPath();

    for (let i = 0; i < waveformPoints; i++) {
      const x = connectionStartX + i * pointSpacing;

      // Create wave pattern with multiple frequencies
      const time = Date.now() / 1000;
      const baseWave = Math.sin((i * 0.3) + (time * 3)) * 0.5;
      const detailWave = Math.sin((i * 0.8) + (time * 8)) * 0.3;
      const microWave = Math.sin((i * 1.5) + (time * 15)) * 0.2;

      // Combine waves and apply audio amplitude
      const waveValue = (baseWave + detailWave + microWave) * normalizedAmplitude;

      // Scale the wave amplitude based on audio activity
      const maxAmplitude = 30 + (normalizedAmplitude * 40); // 30-70px amplitude range
      const waveY = y + (waveValue * maxAmplitude);

      if (i === 0) {
        this.ctx.moveTo(x, waveY);
      } else {
        this.ctx.lineTo(x, waveY);
      }
    }

    this.ctx.stroke();

    // Add glow effect when audio is active
    if (normalizedAmplitude > 0.1) {
      this.ctx.shadowColor = "#ffffff";
      this.ctx.shadowBlur = 10 + (normalizedAmplitude * 20);
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
    }

    // Draw subtle baseline when no audio
    if (normalizedAmplitude < 0.05) {
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([5, 5]);
      this.ctx.lineDashOffset = -Date.now() / 100;

      this.ctx.beginPath();
      this.ctx.moveTo(connectionStartX, y);
      this.ctx.lineTo(connectionEndX, y);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector("canvas") as HTMLCanvasElement;
    const rect = this.getBoundingClientRect();
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      const r = this.getBoundingClientRect();
      this.canvas.style.width = `${r.width}px`;
      this.canvas.style.height = `${r.height}px`;
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
    });
    resizeObserver.observe(this.canvas);

    this.init();
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gdm-live-audio-waveform": GdmLiveAudioWaveform;
  }
}
