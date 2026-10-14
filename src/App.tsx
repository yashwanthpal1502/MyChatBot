import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Check, ChevronDown, CircleHelp, Command, Compass, Copy, Cpu, Menu, MessageSquarePlus, MoreHorizontal, PanelLeftClose, Pencil, Search, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react'
import './yashu.css'

type Model = { name: string; size: number }
type Message = { id: number; role: 'user' | 'assistant'; content: string; created_at: string }
type Conversation = { id: string; title: string; model: string; updated_at: string; message_count: number }
type StreamEvent = { type: string; content?: string; conversationId?: string; message?: string }
const formatSize = (bytes: number) => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`

function App() {
  const [models, setModels] = useState<Model[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [model, setModel] = useState('')
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isOnline, setIsOnline] = useState<boolean | null>(null)
  const [chatError, setChatError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  async function refreshConversations() {
    const response = await fetch('/api/conversations')
    if (response.ok) setConversations(await response.json() as Conversation[])
  }
  async function openConversation(id: string) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
    if (!response.ok) return
    const data = await response.json() as { conversation: Conversation; messages: Message[] }
    setActiveId(id); setMessages(data.messages); setModel(data.conversation.model); setChatError(''); setSidebarOpen(false)
  }

  useEffect(() => {
    let cancelled = false
    void fetch('/api/models').then(async (response) => {
        if (!response.ok) throw new Error('Ollama is not responding')
        const data = await response.json() as { models: Model[] }
        if (cancelled) return
        setModels(data.models); setIsOnline(true)
        if (data.models.length) setModel(data.models.some((item) => item.name === 'llama3.2:3b') ? 'llama3.2:3b' : data.models[0].name)
      }).catch(() => { if (!cancelled) setIsOnline(false) })
    void fetch('/api/conversations').then((response) => response.ok ? response.json() as Promise<Conversation[]> : [])
      .then((data) => { if (!cancelled) setConversations(data) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!isStreaming) { setActiveId(null); setMessages([]); setChatError(''); setDraft(''); setSidebarOpen(false); textareaRef.current?.focus() }
      }
      if (event.key === 'Escape') setModelMenuOpen(false)
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [isStreaming])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: isStreaming ? 'smooth' : 'instant', block: 'end' }) }, [messages, isStreaming])
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) { textarea.style.height = '0px'; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px` }
  }, [draft])

  function startNewChat() {
    setActiveId(null); setMessages([]); setChatError(''); setDraft(''); setSidebarOpen(false); textareaRef.current?.focus()
  }
  async function removeConversation(id: string) {
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (activeId === id) startNewChat()
    await refreshConversations()
  }
  async function renameConversation(conversation: Conversation) {
    const title = window.prompt('Rename conversation', conversation.title)
    if (!title?.trim()) return
    await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim() }) })
    await refreshConversations()
  }
  async function copyMessage(message: Message) {
    await navigator.clipboard.writeText(message.content); setCopiedId(message.id); window.setTimeout(() => setCopiedId(null), 1400)
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || isStreaming || !model) return
    const userMessage: Message = { id: Date.now(), role: 'user', content: text, created_at: new Date().toISOString() }
    const assistantMessage: Message = { id: Date.now() + 1, role: 'assistant', content: '', created_at: new Date().toISOString() }
    setMessages((current) => [...current, userMessage, assistantMessage]); setDraft(''); setChatError(''); setIsStreaming(true)
    const controller = new AbortController(); abortRef.current = controller
    let conversationId = activeId
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, model, message: text }), signal: controller.signal })
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({ error: 'The model could not be reached.' })) as { error?: string }
        throw new Error(error.error ?? 'The model could not be reached.')
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      const handleFrame = (frame: string) => {
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (!dataLine) return
        const payload = JSON.parse(dataLine.slice(6)) as StreamEvent
        if (payload.type === 'meta' && payload.conversationId) { conversationId = payload.conversationId; setActiveId(payload.conversationId) }
        if (payload.type === 'delta' && payload.content) setMessages((current) => current.map((item) => item.id === assistantMessage.id ? { ...item, content: item.content + payload.content } : item))
        if (payload.type === 'error') setChatError(payload.message ?? 'The model stopped unexpectedly.')
      }
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const frames = buffer.split('\n\n'); buffer = frames.pop() ?? ''
        for (const frame of frames) handleFrame(frame)
        if (done) break
      }
      if (buffer.trim()) handleFrame(buffer)
      await refreshConversations()
      if (conversationId) {
        const saved = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`)
        if (saved.ok) {
          const data = await saved.json() as { messages: Message[] }
          setMessages(data.messages)
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') setChatError(error.message)
    } finally {
      await refreshConversations().catch(() => undefined)
      setIsStreaming(false); abortRef.current = null; textareaRef.current?.focus()
    }
  }
  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage() }
  }
  const filteredConversations = conversations.filter((item) => item.title.toLowerCase().includes(search.toLowerCase()))
  const activeConversation = conversations.find((item) => item.id === activeId)

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar-top"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); startNewChat() }} aria-label="YaSHu AI home"><span className="brand-mark"><Sparkles size={19} /></span><span className="brand-name">YaSHu<span> AI</span></span></a><button className="icon-button sidebar-collapse" title="Close sidebar" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></button></div>
      <button className="new-chat-button" onClick={startNewChat} disabled={isStreaming}><MessageSquarePlus size={17} /><span>New conversation</span><kbd>⌘ K</kbd></button>
      <label className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" /><Command size={12} /></label>
      <div className="history-heading">YOUR LIBRARY <span>{filteredConversations.length}</span></div>
      <nav className="conversation-list" aria-label="Conversation history">
        {filteredConversations.map((conversation) => <div key={conversation.id} className={`conversation-row ${activeId === conversation.id ? 'conversation-row--active' : ''}`}>
          <button className="conversation-select" onClick={() => void openConversation(conversation.id)} title={conversation.title}><span className="conversation-title">{conversation.title}</span><span className="conversation-date">{new Date(conversation.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></button>
          <div className="conversation-actions"><button className="icon-button tiny" aria-label="Rename conversation" title="Rename" onClick={() => void renameConversation(conversation)}><Pencil size={13} /></button><button className="icon-button tiny danger-icon" aria-label="Delete conversation" title="Delete" onClick={() => void removeConversation(conversation.id)}><Trash2 size={13} /></button></div>
        </div>)}
        {filteredConversations.length === 0 && <p className="empty-library">{search ? 'No matching conversations' : 'Your conversations will appear here.'}</p>}
      </nav>
      <div className="sidebar-bottom"><div className={`runtime-card ${isOnline === false ? 'runtime-card--offline' : ''}`}><span className="runtime-indicator" /><div><strong>{isOnline === false ? 'Ollama unavailable' : 'Local runtime'}</strong><span>{isOnline ? `${models.length} model${models.length === 1 ? '' : 's'} ready` : 'Checking connection'}</span></div><Cpu size={16} /></div><div className="profile-row"><span className="profile-avatar">Y</span><span><strong>YaSHu AI</strong><small>Private workspace</small></span><MoreHorizontal size={17} /></div></div>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" title="Open sidebar" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><button className="model-picker" onClick={() => setModelMenuOpen((open) => !open)} aria-expanded={modelMenuOpen}><span className="model-dot" /><span>{model || 'Choose a model'}</span><ChevronDown size={14} /></button>
        {modelMenuOpen && <><button className="menu-dismiss" aria-label="Close model menu" onClick={() => setModelMenuOpen(false)} /><div className="model-menu"><div className="menu-heading">LOCAL MODELS</div>{models.map((item) => <button key={item.name} className={`model-option ${model === item.name ? 'model-option--selected' : ''}`} onClick={() => { setModel(item.name); setModelMenuOpen(false) }}><span><strong>{item.name}</strong><small>{formatSize(item.size)} · On device</small></span>{model === item.name && <Check size={16} />}</button>)}{models.length === 0 && <p className="no-models">Start Ollama and pull a model to begin.</p>}<div className="menu-foot"><Settings2 size={14} />Model settings are managed in Ollama</div></div></>}
      </div><div className="topbar-status"><span className={isOnline ? 'status-dot' : 'status-dot status-dot--off'} />{isOnline ? 'Running locally' : 'Disconnected'}</div></header>
      <section className={`chat-scroll ${messages.length === 0 ? 'chat-scroll--empty' : ''}`} aria-live="polite">
        {messages.length === 0 ? <div className="welcome-panel"><div className="welcome-eyebrow"><span className="welcome-spark"><Sparkles size={13} /></span>A little more human, a little more yours</div><h1>Good thinking<br /><span>starts here.</span></h1><p className="welcome-copy">A thoughtful space to explore ideas, untangle a problem, or just see where a question takes you.</p>
          <div className="suggestion-grid">{[
            { icon: <Compass size={17} />, title: 'Explore an idea', detail: 'Help me think through something new' },
            { icon: <ArrowUp size={17} />, title: 'Make a plan', detail: 'Turn a big goal into small steps' },
            { icon: <Command size={17} />, title: 'Write together', detail: 'Find a better way to say it' },
            { icon: <CircleHelp size={17} />, title: 'Get unstuck', detail: 'I have a problem to work out' },
          ].map((suggestion) => <button key={suggestion.title} className="suggestion" onClick={() => { setDraft(suggestion.detail); textareaRef.current?.focus() }}><span className="suggestion-icon">{suggestion.icon}</span><span><strong>{suggestion.title}</strong><small>{suggestion.detail}</small></span><ArrowUp className="suggestion-arrow" size={14} /></button>)}</div>
        </div> : <div className="message-thread">{messages.map((message) => <article key={message.id} className={`message message--${message.role}`}>
          {message.role === 'assistant' && <div className="assistant-avatar"><Sparkles size={15} /></div>}<div className="message-body"><div className="message-label">{message.role === 'assistant' ? 'YaSHu' : 'You'}{message.role === 'assistant' && activeConversation?.model && <span>{activeConversation.model}</span>}</div>
            {message.content ? <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div> : isStreaming && message.role === 'assistant' ? <div className="thinking-indicator"><span /><span /><span /></div> : null}
            {message.role === 'assistant' && message.content && <button className="copy-button" title="Copy response" aria-label="Copy response" onClick={() => void copyMessage(message)}>{copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}<span>{copiedId === message.id ? 'Copied' : 'Copy'}</span></button>}
          </div></article>)}<div ref={endRef} /></div>}
      </section>
      <div className="composer-area">{messages.length > 0 && chatError && <div className="error-banner"><span>{chatError}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setChatError('')}><X size={15} /></button></div>}
        <form className="composer" onSubmit={(event) => void sendMessage(event)}><textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKey} placeholder={isOnline === false ? 'Start Ollama to begin a conversation...' : 'Ask anything, or take your time...'} aria-label="Message YaSHu AI" rows={1} disabled={!isOnline || models.length === 0 || isStreaming} />
          <div className="composer-footer"><div className="composer-hint"><span className="local-lock" />Your messages stay on this device</div><div className="composer-controls"><span className="enter-hint">Shift + Enter for a new line</span>{isStreaming ? <button className="send-button stop-button" type="button" onClick={() => abortRef.current?.abort()} title="Stop generating" aria-label="Stop generating"><Square size={15} fill="currentColor" /></button> : <button className="send-button" type="submit" disabled={!draft.trim() || !model || isOnline === false} title="Send message" aria-label="Send message"><ArrowUp size={18} strokeWidth={2.4} /></button>}</div></div>
        </form><p className="disclaimer">YaSHu can make mistakes. Consider checking important information.</p>
      </div>
    </main>
  </div>
}

export default App
