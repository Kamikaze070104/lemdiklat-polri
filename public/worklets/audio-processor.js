class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        console.log("🛠️ AudioProcessor Worklet Initialized");
        // Buffer size 256 to match previous ScriptProcessor behavior
        this.BUFFER_SIZE = 256;
        this._buffer = new Float32Array(this.BUFFER_SIZE);
        this._bytesWritten = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        // console.log("AudioProcessor processing", input ? input.length : "no input");

        if (!input || !input.length) return true;

        const inputChannel = input[0];

        // Check if we have data
        if (!inputChannel) return true;

        // Buffer the incoming data (usually 128 samples per block)
        for (let i = 0; i < inputChannel.length; i++) {
            this._buffer[this._bytesWritten++] = inputChannel[i];

            // When buffer is full, process and flush
            if (this._bytesWritten >= this.BUFFER_SIZE) {
                this.flush();
            }
        }

        return true;
    }

    flush() {
        // Calculate RMS
        let sumSquares = 0;
        for (let i = 0; i < this.BUFFER_SIZE; i++) {
            sumSquares += this._buffer[i] * this._buffer[i];
        }
        const rms = Math.sqrt(sumSquares / this.BUFFER_SIZE);

        // Clone the buffer to send to main thread
        const bufferToSend = new Float32Array(this._buffer);

        // Apply Noise Gate (Logic moved here for efficiency, or just pass RMS)
        // We pass raw data + rms, let Main Thread decide muting? 
        // No, Main Thread expects pcmData.fill(0) if silent. 
        // Let's do it here or main thread.
        // The previous code did: if (rms < 0.02) pcmData.fill(0).
        // Let's emulate that structure by sending the RMS.

        this.port.postMessage({
            audioData: bufferToSend,
            rms: rms
        });

        // Reset buffer
        this._bytesWritten = 0;
    }
}

registerProcessor('audio-processor', AudioProcessor);
