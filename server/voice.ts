import { HTTPException } from 'hono/http-exception'

export async function transcribe(pcm: ArrayBuffer): Promise<string> {
  const { STT_BASE_URL, STT_API_KEY, STT_MODEL } = process.env
  if (!STT_BASE_URL || !STT_MODEL) {
    throw new HTTPException(503, { message: 'Voice is off. Type your command' })
  }
  if (!pcm.byteLength || pcm.byteLength % 2) {
    throw new HTTPException(400, { message: 'Audio incomplete. Record your command again' })
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(pcm.byteLength + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.byteLength, 40)
  const form = new FormData()
  form.set('model', STT_MODEL)
  form.set('file', new Blob([header, pcm], { type: 'audio/wav' }), 'voice.wav')
  try {
    const response = await fetch(STT_BASE_URL.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: STT_API_KEY ? { Authorization: 'Bearer ' + STT_API_KEY } : {},
    })
    if (response.ok) {
      const data = await response.json()
      if (typeof data?.text === 'string') return data.text.trim()
    }
  } catch { /* An upstream transport failure has the same device-facing recovery. */ }
  throw new HTTPException(502, { message: "Couldn't hear that. Try again or type your command" })
}
