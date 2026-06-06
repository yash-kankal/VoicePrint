# Voice Note Reader

A small app for turning uploaded voice notes into clear Romanized text. It keeps Hindi, Marathi, and English as spoken, but writes Hindi/Marathi in English letters so the message is easier to read. It supports audio and video uploads and sends the file to OpenAI from the local server, so the API key is never exposed in the browser.

## Setup

1. Install dependencies:

```sh
npm install
```

2. Create `.env` from the example:

```sh
cp .env.example .env
```

3. Add your OpenAI key to `.env`:

```sh
OPENAI_API_KEY=your_openai_api_key_here
```

4. Start the app:

```sh
npm run dev
```

Open `http://127.0.0.1:5173`.

## Notes

- The upload limit is 50 MB.
- The default audio transcription model is `gpt-4o-mini-transcribe`.
- The default text cleanup model is `gpt-4.1-mini`.
- You can change these with `OPENAI_TRANSCRIBE_MODEL` and `OPENAI_TEXT_MODEL` in `.env`.
