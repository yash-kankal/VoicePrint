import 'dotenv/config'

import express from 'express'
import multer from 'multer'
import OpenAI, { toFile } from 'openai'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

const app = express()
const port = Number(process.env.PORT ?? 8787)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

// Normalize audio with ffmpeg: convert to 16kHz mono WAV, normalize volume,
// apply a gentle high-pass filter to cut low-frequency rumble.
async function normalizeAudio(inputBuffer, originalName) {
  const ext = path.extname(originalName) || '.audio'
  const inputPath = path.join(tmpdir(), `vp-in-${randomUUID()}${ext}`)
  const outputPath = path.join(tmpdir(), `vp-out-${randomUUID()}.wav`)

  try {
    await writeFile(inputPath, inputBuffer)

    const ffmpegBin = process.env.FFMPEG_PATH ?? 'ffmpeg'
    await execFileAsync(ffmpegBin, [
      '-y',
      '-i', inputPath,
      '-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ])

    const outputBuffer = await readFile(outputPath)
    return outputBuffer
  } finally {
    await unlink(inputPath).catch(() => {})
    await unlink(outputPath).catch(() => {})
  }
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.post('/api/transcribe', upload.single('audio'), async (request, response) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY

    if (!apiKey || apiKey === 'your_openai_api_key_here') {
      response.status(500).json({
        error: 'OpenAI API key is missing. Add OPENAI_API_KEY to your .env file.',
      })
      return
    }

    if (!request.file) {
      response.status(400).json({ error: 'Please upload an audio file.' })
      return
    }

    const client = new OpenAI({ apiKey })

    // Pre-process: normalize and clean the audio
    let audioBuffer = request.file.buffer
    let audioName = request.file.originalname
    let audioType = 'audio/wav'
    try {
      audioBuffer = await normalizeAudio(request.file.buffer, request.file.originalname)
      audioName = audioName.replace(/\.[^.]+$/, '.wav')
    } catch {
      // ffmpeg failed — fall back to raw upload
      audioType = request.file.mimetype || 'application/octet-stream'
    }

    const audioFile = await toFile(audioBuffer, audioName, { type: audioType })

    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe',
      prompt:
        'This is a casual voice note, likely recorded on a phone or via WhatsApp. ' +
        'The speaker may mix Hindi, Marathi, and English freely in the same sentence (Hinglish/Marathinglish). ' +
        'There may be background noise, low volume, or a muffled microphone. ' +
        'Transcribe every word as accurately as possible. ' +
        'Preserve names, places, numbers, and the speaker\'s exact phrasing.',
      response_format: 'json',
      temperature: 0,
    })

    const transcript = transcription.text?.trim() ?? ''

    const normalized = transcript
      ? await client.responses.create({
          model: process.env.OPENAI_TEXT_MODEL ?? 'gpt-4.1-mini',
          input: [
            {
              role: 'developer',
              content:
                'Rewrite transcripts in Roman/English letters only. Do not translate. ' +
                'Preserve the original spoken language and meaning exactly. ' +
                'Hindi and Marathi words must remain Hindi/Marathi — just written in English letters. ' +
                'English words stay English. ' +
                'Keep names, numbers, punctuation, and the speaker\'s intent intact. ' +
                'Return only the rewritten transcript, nothing else.',
            },
            { role: 'user', content: transcript },
          ],
        })
      : null

    response.json({
      text: normalized?.output_text?.trim() || transcript,
      fileName: request.file.originalname,
    })
  } catch (error) {
    const status = error?.status ?? 500
    const message =
      error?.message ?? 'Something went wrong while transcribing. Please try again.'
    response.status(status).json({ error: message })
  }
})

app.use((error, _request, response, next) => {
  if (!error) { next(); return }
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    response.status(413).json({ error: 'The audio file is larger than 50 MB.' })
    return
  }
  response.status(500).json({ error: error.message ?? 'Upload failed.' })
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, '../dist')

app.use(express.static(distPath))
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distPath, 'index.html'))
})

app.listen(port, () => {
  console.log(`Transcribe API running on http://localhost:${port}`)
})
