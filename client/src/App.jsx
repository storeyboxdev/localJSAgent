import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [contextLength, setContextLength] = useState(0);
  const [isCompacting, setIsCompacting] = useState(false);
  const messagesEndRef = useRef(null);
  // Store the full message history for the API (includes tool calls etc.)
  const apiMessagesRef = useRef([]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    fetch("/api/context-info")
      .then((res) => res.json())
      .then((data) => setContextLength(data.contextLength))
      .catch((err) => console.error("Failed to fetch context info:", err));
  }, []);

  const handleCompact = useCallback(async () => {
    if (isCompacting || isLoading) return;
    setIsCompacting(true);

    try {
      const response = await fetch("/api/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessagesRef.current }),
      });

      const data = await response.json();
      if (data.error) {
        console.error("Compact failed:", data.error);
        return;
      }

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
  }, [isCompacting, isLoading]);

  async function sendMessage(e) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setIsLoading(true);

    // Add user message to display
    setMessages((prev) => [...prev, { role: "user", text: userMessage }]);

    // Add to API history
    apiMessagesRef.current.push({ role: "user", content: userMessage });

    // Add placeholder for bot response
    setMessages((prev) => [...prev, { role: "assistant", text: "" }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessagesRef.current }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        // Keep last incomplete line
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
                updated[updated.length - 1] = {
                  ...last,
                  text: last.text + data.text,
                };
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
            } else if (eventType === "done") {
              apiMessagesRef.current = data.messages;
              if (data.tokenCount !== undefined) setTokenCount(data.tokenCount);
              if (data.contextLength !== undefined) setContextLength(data.contextLength);
              if (data.shouldCompact) {
                setTimeout(() => handleCompact(), 100);
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
        updated[updated.length - 1] = {
          ...last,
          text: `Error: ${err.message}`,
        };
        return updated;
      });
    }

    setIsLoading(false);
  }

  const usageRatio = contextLength > 0 ? tokenCount / contextLength : 0;

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="empty-state">Send a message to start chatting</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            {msg.role !== "system" && (
              <div className="message-label">
                {msg.role === "user" ? "You" : "Bot"}
              </div>
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
          placeholder="Type a message..."
          disabled={isLoading || isCompacting}
        />
        <button type="submit" disabled={isLoading || isCompacting || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export default App;
