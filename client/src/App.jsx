import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

// All assignable tools grouped by category
const TOOL_GROUPS = [
  { label: "General", tools: ["dateTime"] },
  { label: "Files", tools: ["readFile", "writeFile", "deleteFile", "listFiles", "changeDirectory", "currentDirectory"] },
  { label: "Web", tools: ["webSearch"] },
  { label: "Knowledge Base", tools: ["ragSearch", "delegateResearch"] },
  { label: "Calendar", tools: ["listCalendars", "setActiveCalendar", "listEvents", "addEvent", "editEvent", "deleteEvent"] },
];

const ICON_OPTIONS = ["🤖", "✨", "📚", "🎯", "💼", "🔬", "🎨", "🗓️", "🔍", "📝", "🎓", "💡"];

// ---------------------------------------------------------------------------
// NewAgentModal — step 0 (choice) → step 1a (archetype grid) or step 1b (mini-chat) → step 2 (form)
// ---------------------------------------------------------------------------
function NewAgentModal({ onClose, onCreated }) {
  const [step, setStep] = useState(0); // 0=choose mode, 1a=archetype grid, 1b=mini-chat, 2a=vars form, 2b=review form
  const [archetypes, setArchetypes] = useState([]);
  const [archetypesLoading, setArchetypesLoading] = useState(false);
  const [archetypesError, setArchetypesError] = useState("");

  // Template flow
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState("");
  const [vars, setVars] = useState({});

  // AI builder flow
  const [converseMessages, setConverseMessages] = useState([]); // { role, content }
  const [converseInput, setConverseInput] = useState("");
  const [converseLoading, setConverseLoading] = useState(false);
  const [detectedConfig, setDetectedConfig] = useState(null); // parsed JSON from <agent-config>

  // Review form (step 2b)
  const [reviewName, setReviewName] = useState("");
  const [reviewIcon, setReviewIcon] = useState("✨");
  const [reviewSystemPrompt, setReviewSystemPrompt] = useState("");
  const [reviewTools, setReviewTools] = useState([]);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const converseEndRef = useRef(null);

  // Fetch archetypes when user chooses the template path
  async function loadArchetypes() {
    setArchetypesLoading(true);
    setArchetypesError("");
    try {
      const res = await fetch("/api/archetypes");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setArchetypes(Array.isArray(data) ? data : []);
    } catch (err) {
      setArchetypesError(err.message);
    } finally {
      setArchetypesLoading(false);
    }
  }

  function goTemplate() {
    setStep("1a");
    loadArchetypes();
  }

  function goAI() {
    setStep("1b");
    // Auto-send the opening message from the AI
    startConversation();
  }

  // Kick off the conversation by sending an empty user message
  async function startConversation() {
    const initialMessages = [{ role: "user", content: "Hi, I want to create a custom AI agent." }];
    setConverseMessages([{ role: "user", content: "Hi, I want to create a custom AI agent." }]);
    await streamConverse(initialMessages);
  }

  async function streamConverse(msgs) {
    setConverseLoading(true);
    try {
      const res = await fetch("/api/agents/converse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      let accumulated = "";
      let eventType = null;

      // Add a placeholder assistant message
      setConverseMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop();

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ") && eventType) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "text") {
              accumulated += data.text;
              setConverseMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: accumulated };
                return updated;
              });
            }
            eventType = null;
          }
        }
      }

      // Check for <agent-config> block
      const configMatch = accumulated.match(/<agent-config>([\s\S]*?)<\/agent-config>/);
      if (configMatch) {
        try {
          const cfg = JSON.parse(configMatch[1].trim());
          setDetectedConfig(cfg);
          // Strip config block from visible message
          setConverseMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: accumulated.replace(/<agent-config>[\s\S]*?<\/agent-config>/, "").trim(),
            };
            return updated;
          });
          // Advance to review step after short delay
          setTimeout(() => advanceToReview(cfg), 800);
        } catch (_) {
          // JSON parse failed — stay in chat
        }
      }
    } catch (err) {
      setConverseMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: `Error: ${err.message}` };
        return updated;
      });
    } finally {
      setConverseLoading(false);
    }
  }

  function advanceToReview(cfg) {
    setReviewName(cfg.name ?? "Custom Agent");
    setReviewIcon(cfg.icon ?? "✨");
    setReviewSystemPrompt(cfg.systemPrompt ?? "");
    setReviewTools(Array.isArray(cfg.tools) ? cfg.tools : []);
    setStep("2b");
  }

  async function sendConverseMessage(e) {
    e.preventDefault();
    if (!converseInput.trim() || converseLoading) return;
    const userMsg = converseInput.trim();
    setConverseInput("");
    const newMessages = [...converseMessages, { role: "user", content: userMsg }];
    setConverseMessages(newMessages);
    await streamConverse(newMessages);
  }

  useEffect(() => {
    converseEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [converseMessages]);

  // Template flow: pick archetype → go to vars form
  function pickArchetype(arch) {
    setSelected(arch);
    setName(arch.defaultInstanceName || arch.name);
    setVars({});
    setError("");
    setStep("2a");
  }

  // Template flow: create from archetype
  async function handleCreateFromArchetype(e) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archetypeId: selected.id, name, variables: vars }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create agent");
      onCreated(data);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  // AI builder flow: create from review form
  async function handleCreateCustom(e) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: reviewName,
          icon: reviewIcon,
          systemPrompt: reviewSystemPrompt,
          tools: reviewTools,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create agent");
      onCreated(data);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  function toggleTool(toolName) {
    setReviewTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName]
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>

        {/* Step 0: Choose mode */}
        {step === 0 && (
          <>
            <h2 className="modal-title">New Agent</h2>
            <div className="mode-cards">
              <button className="mode-card" onClick={goTemplate}>
                <span className="mode-card-icon">📋</span>
                <span className="mode-card-title">Choose a Template</span>
                <span className="mode-card-desc">Start from a pre-built archetype with sensible defaults</span>
              </button>
              <button className="mode-card" onClick={goAI}>
                <span className="mode-card-icon">✨</span>
                <span className="mode-card-title">Build with AI</span>
                <span className="mode-card-desc">Have a short conversation and let AI generate the config</span>
              </button>
            </div>
          </>
        )}

        {/* Step 1a: Archetype grid */}
        {step === "1a" && (
          <>
            <button className="modal-back" onClick={() => setStep(0)}>← Back</button>
            <h2 className="modal-title">Choose a Template</h2>
            {archetypesLoading && <div className="modal-loading">Loading templates...</div>}
            {archetypesError && (
              <div className="modal-error">
                Failed to load: {archetypesError}
                <button className="modal-retry" onClick={loadArchetypes}>Try again</button>
              </div>
            )}
            {!archetypesLoading && !archetypesError && (
              <div className="archetype-grid">
                {archetypes.length === 0 && (
                  <div className="modal-empty">No templates found.</div>
                )}
                {archetypes.map((arch) => (
                  <button
                    key={arch.id}
                    className="archetype-card"
                    onClick={() => pickArchetype(arch)}
                  >
                    <span className="archetype-icon">{arch.icon}</span>
                    <span className="archetype-name">{arch.name}</span>
                    <span className="archetype-desc">{arch.description}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Step 2a: Template variables form */}
        {step === "2a" && selected && (
          <>
            <button className="modal-back" onClick={() => setStep("1a")}>← Back</button>
            <h2 className="modal-title">
              {selected.icon} {selected.name}
            </h2>
            <form className="agent-form" onSubmit={handleCreateFromArchetype}>
              <label className="form-label">
                Name
                <input
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="e.g. Google SWE Prep"
                />
              </label>

              {Object.entries(selected.variables ?? {}).map(([key, def]) => (
                <label key={key} className="form-label">
                  {def.label}
                  {def.required && <span className="required">*</span>}
                  <input
                    className="form-input"
                    value={vars[key] ?? ""}
                    onChange={(e) => setVars((v) => ({ ...v, [key]: e.target.value }))}
                    required={def.required}
                    placeholder={def.default ?? ""}
                  />
                </label>
              ))}

              {error && <div className="form-error">{error}</div>}

              <button className="form-submit" type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create Agent"}
              </button>
            </form>
          </>
        )}

        {/* Step 1b: Mini-chat with AI builder */}
        {step === "1b" && (
          <>
            <button className="modal-back" onClick={() => setStep(0)}>← Back</button>
            <h2 className="modal-title">Build with AI</h2>
            <div className="mini-chat">
              <div className="mini-chat-messages">
                {converseMessages.map((msg, i) => (
                  <div key={i} className={`mini-msg mini-msg-${msg.role}`}>
                    {msg.content || (msg.role === "assistant" && converseLoading ? "..." : "")}
                  </div>
                ))}
                <div ref={converseEndRef} />
              </div>
              <form className="mini-chat-form" onSubmit={sendConverseMessage}>
                <input
                  className="mini-chat-input"
                  value={converseInput}
                  onChange={(e) => setConverseInput(e.target.value)}
                  placeholder="Type your answer..."
                  disabled={converseLoading}
                />
                <button
                  className="mini-chat-send"
                  type="submit"
                  disabled={converseLoading || !converseInput.trim()}
                >
                  Send
                </button>
              </form>
            </div>
          </>
        )}

        {/* Step 2b: Review & edit generated config */}
        {step === "2b" && (
          <>
            <button className="modal-back" onClick={() => setStep("1b")}>← Back</button>
            <h2 className="modal-title">Review Agent Config</h2>
            <form className="agent-form" onSubmit={handleCreateCustom}>
              <label className="form-label">
                Name
                <input
                  className="form-input"
                  value={reviewName}
                  onChange={(e) => setReviewName(e.target.value)}
                  required
                />
              </label>

              <div className="form-label">
                Icon
                <div className="icon-picker">
                  {ICON_OPTIONS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      className={`icon-btn${reviewIcon === em ? " selected" : ""}`}
                      onClick={() => setReviewIcon(em)}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>

              <label className="form-label">
                System Prompt
                <textarea
                  className="form-input form-textarea"
                  value={reviewSystemPrompt}
                  onChange={(e) => setReviewSystemPrompt(e.target.value)}
                  rows={5}
                  required
                />
              </label>

              <div className="form-label">
                Tools
                <div className="tool-groups">
                  {TOOL_GROUPS.map((group) => (
                    <div key={group.label} className="tool-group">
                      <div className="tool-group-label">{group.label}</div>
                      <div className="tool-group-tools">
                        {group.tools.map((t) => (
                          <label key={t} className="tool-checkbox">
                            <input
                              type="checkbox"
                              checked={reviewTools.includes(t)}
                              onChange={() => toggleTool(t)}
                            />
                            <span>{t}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}

              <button className="form-submit" type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create Agent"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KnowledgeBasePanel — document upload + list (agent-aware)
// ---------------------------------------------------------------------------
function KnowledgeBasePanel({ onClose, activeAgentId, activeAgent }) {
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState([]);
  const [dragging, setDragging] = useState(false);
  // When an agent is active, default to showing only that agent's docs
  const [showAll, setShowAll] = useState(!activeAgentId);
  const fileInputRef = useRef(null);

  async function fetchDocs(forceAll = false) {
    try {
      const useAgentScope = activeAgentId && !forceAll && !showAll;
      const url = useAgentScope
        ? `/api/documents?agentId=${activeAgentId}`
        : "/api/documents";
      const res = await fetch(url);
      const data = await res.json();
      setDocs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch documents:", err);
    }
  }

  useEffect(() => { fetchDocs(); }, [showAll]);

  async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadResults([]);
    const formData = new FormData();
    for (const file of files) formData.append("files", file);
    if (activeAgentId) formData.append("agentId", activeAgentId);
    try {
      const res = await fetch("/api/documents/upload", { method: "POST", body: formData });
      const data = await res.json();
      setUploadResults(data.results ?? []);
      await fetchDocs();
    } catch (err) {
      setUploadResults([{ filename: "upload", status: "error", error: err.message }]);
    } finally {
      setUploading(false);
    }
  }

  async function deleteDoc(id, filename) {
    if (!window.confirm(`Delete "${filename}" from knowledge base?`)) return;
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    await fetchDocs();
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    uploadFiles(Array.from(e.dataTransfer.files));
  }

  const agentScoped = activeAgentId && !showAll;
  const title = activeAgent
    ? `${activeAgent.icon ?? "📚"} ${activeAgent.name}'s Knowledge Base`
    : "Knowledge Base";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal kb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="modal-title">{title}</h2>

        {activeAgentId && (
          <button
            className="kb-scope-toggle"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll
              ? `← Back to ${activeAgent?.name ?? "agent"}'s docs`
              : "Show all documents"}
          </button>
        )}

        <div
          className={`drop-zone${dragging ? " drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.js,.ts,.jsx,.tsx,.py,.json,.csv,.html,.htm,.pdf,.docx"
            style={{ display: "none" }}
            onChange={(e) => uploadFiles(Array.from(e.target.files))}
          />
          {uploading ? (
            <span>Indexing files...</span>
          ) : (
            <>
              <span>Drop files here or click to browse</span>
              {agentScoped && activeAgent && (
                <span className="kb-agent-badge">
                  Files uploaded here will be linked to {activeAgent.name}
                </span>
              )}
              {!agentScoped && (
                <span className="drop-zone-hint">Supported: text, code, PDF, DOCX</span>
              )}
            </>
          )}
        </div>

        {uploadResults.length > 0 && (
          <div className="upload-results">
            {uploadResults.map((r, i) => (
              <div key={i} className={`upload-result ${r.status}`}>
                {r.status === "ok"
                  ? `✓ ${r.filename} — ${r.chunkCount} chunks`
                  : `✗ ${r.filename}: ${r.error}`}
              </div>
            ))}
          </div>
        )}

        <div className="doc-list">
          {docs.length === 0 && (
            <div className="doc-empty">
              {agentScoped
                ? `No documents linked to ${activeAgent?.name ?? "this agent"} yet.`
                : "No documents indexed yet."}
            </div>
          )}
          {docs.map((doc) => (
            <div key={doc.id} className="doc-item">
              <div className="doc-info">
                <span className="doc-name">{doc.filename}</span>
                <span className="doc-meta">{doc.chunkCount} chunks</span>
              </div>
              <button
                className="doc-delete"
                onClick={() => deleteDoc(doc.id, doc.filename)}
                title="Delete from knowledge base"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [contextLength, setContextLength] = useState(0);
  const [isCompacting, setIsCompacting] = useState(false);

  // Agent / archetype state
  const [agents, setAgents] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState(null);
  const [showNewAgentModal, setShowNewAgentModal] = useState(false);
  const [showKBPanel, setShowKBPanel] = useState(false);

  // Calendar event notifications from the monitor
  const [agentNotification, setAgentNotification] = useState(null);

  const messagesEndRef = useRef(null);
  const apiMessagesRef = useRef([]);

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    fetch("/api/context-info")
      .then((r) => r.json())
      .then((d) => setContextLength(d.contextLength))
      .catch(console.error);

    fetchAgents();
  }, []);

  // Persistent SSE connection for calendar event notifications
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "agent-event") {
          setAgents((prev) => {
            const agent = prev.find((a) => a.id === data.agentId);
            setAgentNotification({
              agentId: data.agentId,
              agentName: agent?.name ?? "Agent",
              agentIcon: agent?.icon ?? "🤖",
              summary: data.event.summary,
            });
            return prev;
          });
        } else if (data.type === "news-briefing") {
          setAgentNotification({
            agentId: data.agentId,
            agentName: data.agentName ?? "News Briefing",
            agentIcon: data.agentIcon ?? "📰",
            summary: data.summary ?? "Your news briefing is ready",
          });
        }
      } catch (_) {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  async function fetchAgents() {
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch agents:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent switching
  // ---------------------------------------------------------------------------
  async function loadAgent(id) {
    if (isLoading || isCompacting) return;
    try {
      const res = await fetch(`/api/agents/${id}`);
      const instance = await res.json();
      if (!res.ok) throw new Error(instance.error);

      apiMessagesRef.current = instance.messages ?? [];

      // Reconstruct display messages (show only user/assistant text)
      const display = [];
      for (const msg of instance.messages ?? []) {
        if (msg.role === "user") {
          const content = typeof msg.content === "string"
            ? msg.content
            : msg.content?.find?.((p) => p.type === "text")?.text ?? "";
          if (content) display.push({ role: "user", text: content });
        } else if (msg.role === "assistant") {
          const content = typeof msg.content === "string"
            ? msg.content
            : msg.content?.find?.((p) => p.type === "text")?.text ?? "";
          if (content) display.push({ role: "assistant", text: content });
        }
      }

      setMessages(display);
      setActiveAgentId(id);
      setTokenCount(instance.tokenCount ?? 0);
    } catch (err) {
      console.error("Failed to load agent:", err);
    }
  }

  function startNewChat() {
    apiMessagesRef.current = [];
    setMessages([]);
    setActiveAgentId(null);
    setTokenCount(0);
  }

  async function handleAgentCreated(newAgent) {
    await fetchAgents();
    await loadAgent(newAgent.id);
  }

  async function renameAgent(id, currentName) {
    const newName = window.prompt("Rename agent:", currentName);
    if (!newName || newName === currentName) return;
    await fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    await fetchAgents();
  }

  async function deleteAgentUI(id) {
    const agent = agents.find((a) => a.id === id);
    if (!window.confirm(`Delete "${agent?.name}"?`)) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    if (activeAgentId === id) startNewChat();
    await fetchAgents();
  }

  // ---------------------------------------------------------------------------
  // Compact
  // ---------------------------------------------------------------------------
  const handleCompact = useCallback(async () => {
    if (isCompacting || isLoading) return;
    setIsCompacting(true);
    try {
      const body = { messages: apiMessagesRef.current };
      if (activeAgentId) body.agentId = activeAgentId;

      const response = await fetch("/api/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.error) { console.error("Compact failed:", data.error); return; }

      apiMessagesRef.current = data.messages;

      if (data.compacted) {
        setMessages((prev) => {
          const KEEP_DISPLAY = 6;
          const kept = prev.slice(-KEEP_DISPLAY);
          return [
            { role: "system", text: "[Conversation compacted — older messages summarized]" },
            ...kept,
          ];
        });
      }

      if (data.tokenCount !== undefined) setTokenCount(data.tokenCount);
    } catch (err) {
      console.error("Compact error:", err);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, isLoading, activeAgentId]);

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------
  async function sendMessage(e) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setIsLoading(true);

    setMessages((prev) => [...prev, { role: "user", text: userMessage }]);
    apiMessagesRef.current.push({ role: "user", content: userMessage });
    setMessages((prev) => [...prev, { role: "assistant", text: "", think: "" }]);

    try {
      const body = { messages: apiMessagesRef.current };
      if (activeAgentId) body.agentId = activeAgentId;

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop();

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ") && eventType) {
            const data = JSON.parse(line.slice(6));

            if (eventType === "text") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, text: last.text + data.text };
                return updated;
              });
            } else if (eventType === "tool-call") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = {
                  ...last,
                  text: last.text + `\n[calling ${data.toolName}...]\n`,
                };
                return updated;
              });
            } else if (eventType === "think") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = {
                  ...last,
                  think: (last.think ?? "") + data.text,
                };
                return updated;
              });
            } else if (eventType === "done") {
              apiMessagesRef.current = data.messages;
              if (data.tokenCount !== undefined) setTokenCount(data.tokenCount);
              if (data.contextLength !== undefined) setContextLength(data.contextLength);
              if (data.shouldCompact) setTimeout(() => handleCompact(), 100);
              // Update sidebar agent entry without full refetch
              if (data.agentId) {
                setAgents((prev) =>
                  prev.map((a) =>
                    a.id === data.agentId
                      ? {
                          ...a,
                          tokenCount: data.tokenCount ?? a.tokenCount,
                          messageCount: data.messages.filter(
                            (m) => m.role === "user" || m.role === "assistant"
                          ).length,
                          updatedAt: new Date().toISOString(),
                        }
                      : a
                  )
                );
              }
            } else if (eventType === "error") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = {
                  ...last,
                  text: last.text + `\nError: ${data.error}`,
                };
                return updated;
              });
            }
            eventType = null;
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, text: `Error: ${err.message}` };
        return updated;
      });
    }

    setIsLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const usageRatio = contextLength > 0 ? tokenCount / contextLength : 0;
  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Resolve icon for an agent (stored directly on instance now, fallback to ✨)
  function agentIcon(agent) {
    return agent.icon ?? (agent.isCustom ? "✨" : "🤖");
  }

  return (
    <div className="app-root">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="sidebar-new-chat" onClick={startNewChat} title="New general chat">
            + New Chat
          </button>
          <button
            className="sidebar-new-agent"
            onClick={() => setShowNewAgentModal(true)}
            title="Create a new agent"
          >
            + Agent
          </button>
        </div>

        <div className="sidebar-section-label">Agents</div>
        <div className="sidebar-agents">
          {agents.length === 0 && (
            <div className="sidebar-empty">No agents yet. Create one with + Agent.</div>
          )}
          {agents.map((agent) => (
            <div
              key={agent.id}
              className={`sidebar-agent${activeAgentId === agent.id ? " active" : ""}`}
              onClick={() => loadAgent(agent.id)}
            >
              <span className="sidebar-agent-icon">{agentIcon(agent)}</span>
              <div className="sidebar-agent-info">
                <span className="sidebar-agent-name">{agent.name}</span>
                <span className="sidebar-agent-meta">{agent.messageCount ?? 0} messages</span>
              </div>
              <div className="sidebar-agent-actions">
                <button
                  onClick={(e) => { e.stopPropagation(); renameAgent(agent.id, agent.name); }}
                  title="Rename"
                >✏️</button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteAgentUI(agent.id); }}
                  title="Delete"
                >🗑️</button>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button
            className="sidebar-kb-btn"
            onClick={() => setShowKBPanel(true)}
            title="Manage knowledge base documents"
          >
            📚 Knowledge Base
          </button>
        </div>
      </aside>

      {/* Main chat panel */}
      <div className="chat-container">
        {activeAgent && (
          <div className="agent-banner">
            <span>{agentIcon(activeAgent)}</span>
            <span className="agent-banner-name">{activeAgent.name}</span>
            {!activeAgent.isCustom && (
              <span className="agent-banner-type">
                {activeAgent.archetypeId}
              </span>
            )}
          </div>
        )}

        {agentNotification && (
          <div className="agent-notification" onClick={() => {
            loadAgent(agentNotification.agentId);
            setInput(`My scheduled event "${agentNotification.summary}" is starting now.`);
            setAgentNotification(null);
          }}>
            <span>📅 <strong>{agentNotification.agentIcon} {agentNotification.agentName}</strong>: "{agentNotification.summary}" — click to open</span>
            <button className="agent-notification-close" onClick={(e) => { e.stopPropagation(); setAgentNotification(null); }}>✕</button>
          </div>
        )}

        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="empty-state">
              {activeAgent
                ? `Chat with ${activeAgent.name}`
                : "Send a message to start chatting"}
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              {msg.role !== "system" && (
                <div className="message-label">
                  {msg.role === "user" ? "You" : activeAgent?.name ?? "Bot"}
                </div>
              )}
              {msg.think && (
                <details className="think-bubble">
                  <summary>Thinking...</summary>
                  <div className="think-content">{msg.think}</div>
                </details>
              )}
              <div className="message-text">{msg.text}</div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.text === "" && (
            <div className="thinking">Thinking...</div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="status-bar">
          <div className="token-info">
            <div className="token-bar-container">
              <div
                className="token-bar-fill"
                style={{ width: `${Math.min(usageRatio * 100, 100)}%` }}
                data-warning={usageRatio > 0.8}
              />
            </div>
            <span className="token-text">
              {tokenCount.toLocaleString()} / {contextLength.toLocaleString()} tokens
            </span>
          </div>
          <button
            className="compact-btn"
            onClick={handleCompact}
            disabled={isLoading || isCompacting || messages.length < 4}
            title="Summarize older messages to free up context space"
          >
            {isCompacting ? "Compacting..." : "Compact"}
          </button>
        </div>

        <form className="chat-input" onSubmit={sendMessage}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={activeAgent ? `Message ${activeAgent.name}...` : "Type a message..."}
            disabled={isLoading || isCompacting}
          />
          <button type="submit" disabled={isLoading || isCompacting || !input.trim()}>
            Send
          </button>
        </form>
      </div>

      {/* Modals */}
      {showNewAgentModal && (
        <NewAgentModal
          onClose={() => setShowNewAgentModal(false)}
          onCreated={handleAgentCreated}
        />
      )}
      {showKBPanel && (
        <KnowledgeBasePanel
          onClose={() => setShowKBPanel(false)}
          activeAgentId={activeAgentId}
          activeAgent={activeAgent}
        />
      )}
    </div>
  );
}

export default App;
