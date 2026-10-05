// Runs at the AudioContext's 16 kHz sample rate, using the recorder's microphone.
class RealtimePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.flush();
        this.port.postMessage('flushed');
      }
    };
  }
  flush() {
    if (!this.samples.length) return;
    const pcm = new Int16Array(this.samples.length);
    for (let i = 0; i < pcm.length; i++) {
      const value = Math.max(-1, Math.min(1, this.samples[i]));
      pcm[i] = value < 0 ? value * 32768 : value * 32767;
    }
    this.samples = [];
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.samples.push(...channel);
    if (this.samples.length >= 2048) this.flush();
    return true;
  }
}
registerProcessor('twentyseven-pcm', RealtimePCM);
