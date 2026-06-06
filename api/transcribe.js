import 'dotenv/config'

import OpenAI, { toFile } from 'openai'
import formidable from 'formidable'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export const config = { api: { bodyParser: false } }

const execFileAsync = promisify(execFile)

async function normalizeAudio(inputBuffer, originalName) {
  const ext = path.extname(originalName) || '.audio'
  const inputPath = path.join(tmpdir(), `vp-in-${randomUUID()}${ext}`)
  const outputPath = path.join(tmpdir(), `vp-out-${randomUUID()}.wav`)
  try {
    await writeFile(inputPath, inputBuffer)
    const ffmpegBin = process.env.FFMPEG_PATH ?? 'ffmpeg'
    await execFileAsync(ffmpegBin, [
      '-y', '-i', inputPath,
      '-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      outputPath,
    ])
    return await readFile(outputPath)
  } finally {
    await unlink(inputPath).catch(() => {})
    await unlink(outputPath).catch(() => {})
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    res.status(500).json({ error: 'OpenAI API key is missing. Add OPENAI_API_KEY in your Vercel environment variables.' })
    return
  }

  const form = formidable({
    maxFileSize: 50 * 1024 * 1024,
    uploadDir: tmpdir(),
    keepExtensions: true,
  })

  let files
  try {
    ;[, files] = await form.parse(req)
  } catch (err) {
    const isTooBig = err?.code === 1009 || err?.message?.includes('maxFileSize')
    res.status(isTooBig ? 413 : 400).json({
      error: isTooBig ? 'The audio file is larger than 50 MB.' : 'Upload failed.',
    })
    return
  }

  const uploaded = files.audio?.[0]
  if (!uploaded) {
    res.status(400).json({ error: 'Please upload an audio file.' })
    return
  }

  try {
    const client = new OpenAI({ apiKey })

    let audioBuffer = await readFile(uploaded.filepath)
    let audioName = uploaded.originalFilename || 'audio.wav'
    let audioType = uploaded.mimetype || 'application/octet-stream'

    try {
      audioBuffer = await normalizeAudio(audioBuffer, audioName)
      audioName = audioName.replace(/\.[^.]+$/, '.wav')
      audioType = 'audio/wav'
    } catch {
      // ffmpeg unavailable (expected on Vercel) — use raw file
    }

    await unlink(uploaded.filepath).catch(() => {})

    const audioFile = await toFile(audioBuffer, audioName, { type: audioType })

    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe',
      prompt:
        'This is a casual voice note, likely recorded on a phone or via WhatsApp. ' +
        'The speaker may mix Hindi, Marathi, and English freely in the same sentence (Hinglish/Marathinglish). ' +
        'There may be background noise, low volume, or a muffled microphone. ' +
        'Transcribe every word as accurately as possible. ' +
        "Preserve names, places, numbers, and the speaker's exact phrasing.",
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
                "Keep names, numbers, punctuation, and the speaker's intent intact. " +
                'Return only the rewritten transcript, nothing else.',
            },
            { role: 'user', content: transcript },
          ],
        })
      : null

    res.status(200).json({
      text: normalized?.output_text?.trim() || transcript,
      fileName: uploaded.originalFilename,
    })
  } catch (error) {
    const status = error?.status ?? 500
    const message = error?.message ?? 'Something went wrong while transcribing. Please try again.'
    res.status(status).json({ error: message })
  }
}
