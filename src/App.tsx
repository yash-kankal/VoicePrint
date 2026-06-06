import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Check,
  Copy,
  Download,
  FileAudio,
  FileText,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react'
import './App.css'

type TranscribeResponse = {
  text?: string
  error?: string
}

type Stage = 'idle' | 'transcribing' | 'cleaning'

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function highlight(text: string, query: string, activeIndex: number) {
  if (!query) return <>{text}</>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  let matchCount = 0
  return (
    <>
      {parts.map((part, i) => {
        if (part.toLowerCase() === query.toLowerCase()) {
          const idx = matchCount++
          return (
            <mark
              key={i}
              className={`search-match${idx === activeIndex ? ' search-match--active' : ''}`}
              data-match-index={idx}
            >
              {part}
            </mark>
          )
        }
        return part
      })}
    </>
  )
}

function App() {
  const [file, setFile] = useState<File | null>(null)
  const [transcript, setTranscript] = useState('')
  const [visibleTranscript, setVisibleTranscript] = useState('')
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

  // search
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  const stageCleaningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isLoading = stage !== 'idle'
  const isTyping = transcript.length > visibleTranscript.length

  const searchMatchCount = useMemo(() => {
    if (!searchQuery || !transcript) return 0
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return (transcript.match(new RegExp(escaped, 'gi')) ?? []).length
  }, [searchQuery, transcript])

  const fileLabel = useMemo(() => {
    if (!file) return 'Choose audio'
    return `${file.name} | ${formatBytes(file.size)}`
  }, [file])

  // typing animation
  useEffect(() => {
    if (!transcript) return undefined
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) {
      const id = window.setTimeout(() => setVisibleTranscript(transcript), 0)
      return () => window.clearTimeout(id)
    }
    let idx = 0
    const charsPerFrame = Math.max(2, Math.ceil(transcript.length / 220))
    const id = window.setInterval(() => {
      idx = Math.min(transcript.length, idx + charsPerFrame)
      setVisibleTranscript(transcript.slice(0, idx))
      if (idx >= transcript.length) window.clearInterval(id)
    }, 18)
    return () => window.clearInterval(id)
  }, [transcript])

  // scroll active match into view
  useEffect(() => {
    if (!searchOpen || !searchQuery) return
    const el = transcriptRef.current?.querySelector<HTMLElement>(
      `[data-match-index="${searchActive}"]`,
    )
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [searchActive, searchOpen, searchQuery])

  // open search with Ctrl+F / Cmd+F when transcript is present
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && transcript) {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
      }
      if (e.key === 'Escape' && searchOpen) {
        closeSearch()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [transcript, searchOpen])

  function closeSearch() {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchActive(0)
  }

  const openSearch = () => {
    setSearchOpen(true)
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (searchMatchCount === 0) return
      setSearchActive(n => (e.shiftKey ? (n - 1 + searchMatchCount) % searchMatchCount : (n + 1) % searchMatchCount))
    }
    if (e.key === 'Escape') closeSearch()
  }

  const setSelectedFile = (f?: File) => {
    if (!f) return
    setFile(f)
    setTranscript('')
    setVisibleTranscript('')
    setError('')
    setCopied(false)
    closeSearch()
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => setSelectedFile(e.target.files?.[0])

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setIsDragging(false)
    setSelectedFile(e.dataTransfer.files?.[0])
  }

  const transcribe = async () => {
    if (!file) { setError('Please choose an audio file first.'); return }

    setStage('transcribing')
    setError('')
    setTranscript('')
    setVisibleTranscript('')
    setCopied(false)
    setIsEditing(false)
    closeSearch()

    // switch label to "Cleaning up…" after 6 s — a reasonable point when
    // transcription is likely done and the text cleanup pass has begun
    stageCleaningTimerRef.current = setTimeout(() => setStage('cleaning'), 6000)

    const formData = new FormData()
    formData.append('audio', file)

    try {
      const response = await fetch('/api/transcribe', { method: 'POST', body: formData })
      const data = (await response.json()) as TranscribeResponse
      if (!response.ok) throw new Error(data.error ?? 'Transcription failed.')
      setTranscript(data.text ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed.')
    } finally {
      if (stageCleaningTimerRef.current) clearTimeout(stageCleaningTimerRef.current)
      setStage('idle')
    }
  }

  const copyTranscript = async () => {
    if (!transcript) return
    await navigator.clipboard.writeText(transcript)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const downloadTranscript = () => {
    if (!transcript) return
    const baseName = file?.name.replace(/\.[^.]+$/, '') ?? 'transcript'
    const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${baseName}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const clearFile = () => {
    setFile(null)
    setTranscript('')
    setVisibleTranscript('')
    setError('')
    setCopied(false)
    closeSearch()
  }

  const loadingLabel = stage === 'cleaning' ? 'Cleaning up…' : 'Transcribing…'

  return (
    <main className="shell">
      <section className="app-frame" aria-labelledby="page-title">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <img src="/logo.svg" alt="" className="brand-logo" />
            </span>
            <h1 id="page-title">VoicePrint</h1>
          </div>
        </header>

        <div className="workspace">
          <section className="control-panel" aria-label="Audio upload">
            <label
              className={`dropzone ${isDragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`}
              onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
            >
              <input type="file" accept="audio/*,video/*" onChange={onFileChange} />
              <span className="dropzone-icon" aria-hidden="true">
                <FileAudio size={34} strokeWidth={1.7} />
              </span>
              <span className="file-name">{fileLabel}</span>
              <span className="file-meta">Audio or video</span>
              {!file && <span className="dropzone-hint">Drag & drop or click to upload</span>}
            </label>

            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={isLoading || !file}
                onClick={transcribe}
              >
                {isLoading ? (
                  <LoaderCircle className="spin" size={19} aria-hidden="true" />
                ) : (
                  <Upload size={19} aria-hidden="true" />
                )}
                <span>{isLoading ? loadingLabel : 'Transcribe'}</span>
              </button>

              {file ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear selected file"
                  title="Clear selected file"
                  onClick={clearFile}
                >
                  <X size={19} aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {error ? <p className="error">{error}</p> : null}
          </section>

          <section
            className="result"
            aria-live="polite"
            aria-label="Romanized transcript"
          >
            <div className="result-header">
              <div className="result-title">
                <span aria-hidden="true">
                  <FileText size={18} strokeWidth={2} />
                </span>
                <h2>Romanized Transcript</h2>
              </div>
              <div className="result-actions">
                <button
                  type="button"
                  className={`icon-button${isEditing ? ' icon-button--active' : ''}`}
                  aria-label={isEditing ? 'Stop editing' : 'Edit transcript'}
                  title="Edit transcript"
                  disabled={!transcript || isTyping}
                  onClick={() => setIsEditing(e => !e)}
                >
                  <Pencil size={17} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Re-transcribe"
                  title="Try again"
                  disabled={!file || isLoading}
                  onClick={transcribe}
                >
                  <RefreshCw size={17} aria-hidden="true" />
                </button>
                {searchOpen ? (
                  <div className="search-bar" role="search">
                    <Search size={15} aria-hidden="true" className="search-icon" />
                    <input
                      ref={searchInputRef}
                      type="search"
                      className="search-input"
                      placeholder="Search…"
                      value={searchQuery}
                      onChange={e => { setSearchQuery(e.target.value); setSearchActive(0) }}
                      onKeyDown={onSearchKeyDown}
                      aria-label="Search transcript"
                    />
                    {searchQuery ? (
                      <span className="search-count" aria-live="polite">
                        {searchMatchCount === 0
                          ? '0'
                          : `${searchActive + 1}/${searchMatchCount}`}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="icon-button search-close"
                      aria-label="Close search"
                      onClick={closeSearch}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Search transcript"
                    title="Search (Ctrl+F)"
                    disabled={!transcript}
                    onClick={openSearch}
                  >
                    <Search size={19} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Download transcript as text file"
                  title="Download .txt"
                  disabled={!transcript}
                  onClick={downloadTranscript}
                >
                  <Download size={19} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Copy transcript"
                  title="Copy transcript"
                  disabled={!transcript}
                  onClick={copyTranscript}
                >
                  {copied ? (
                    <Check size={19} aria-hidden="true" />
                  ) : (
                    <Copy size={19} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {isEditing ? (
              <textarea
                className="transcript has-text is-editable"
                value={transcript}
                onChange={e => {
                  setTranscript(e.target.value)
                  setVisibleTranscript(e.target.value)
                }}
                aria-label="Edit transcript"
                spellCheck={false}
              />
            ) : (
              <div
                ref={transcriptRef}
                className={`transcript ${transcript ? 'has-text' : 'is-empty'} ${isTyping ? 'is-typing' : ''}`}
                aria-busy={isTyping}
              >
                {transcript ? (
                  <>
                    {searchOpen && searchQuery
                      ? highlight(visibleTranscript, searchQuery, searchActive)
                      : visibleTranscript}
                    {isTyping ? (
                      <span className="typing-cursor" aria-hidden="true"></span>
                    ) : null}
                  </>
                ) : (
                  <div className="empty-state">
                    <span aria-hidden="true">
                      <FileText size={28} strokeWidth={1.8} />
                    </span>
                    <p>The transcript will appear here.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}

export default App
