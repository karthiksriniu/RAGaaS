"use client";

import { useEffect, useRef, useState } from "react";

interface Citation {
  index: number;
  source_uri: string;
  heading: string | null;
  excerpt: string;
  similarity: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
}

interface SourceRow {
  source_uri: string;
  source_type: string;
  chunk_count: number;
  ingested_at: string;
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function refreshSources() {
    const res = await fetch("/api/ingest");
    const data = await res.json();
    setSources(data.sources || []);
  }

  useEffect(() => {
    refreshSources();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;

    setMessages((m) => [...m, { role: "user", text: q }]);
    setQuestion("");
    setAsking(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setMessages((m) => [
        ...m,
        { role: "assistant", text: data.answer, citations: data.citations },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      await refreshSources();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeleteSource(sourceUri: string) {
    await fetch("/api/ingest", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUri }),
    });
    await refreshSources();
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-green-800">AgriAdvisor</h1>
        <button
          onClick={() => setDrawerOpen(true)}
          className="rounded-full border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700"
        >
          Knowledge sources
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-12 text-center text-neutral-500">
            <p className="text-base">
              Ask a question about seeds, crop conditions, or agronomy.
            </p>
            <p className="mt-2 text-sm">
              Answers are drawn from the uploaded knowledge base.
            </p>
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-2xl px-4 py-3 ${
                m.role === "user"
                  ? "ml-auto max-w-[85%] bg-green-700 text-white"
                  : "mr-auto max-w-[92%] border border-neutral-200 bg-white"
              }`}
            >
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.text}</p>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-3 flex flex-col gap-2 border-t border-neutral-200 pt-2">
                  {m.citations.map((c) => (
                    <div key={c.index} className="rounded-lg bg-neutral-50 p-2 text-xs text-neutral-600">
                      <span className="font-semibold">
                        [{c.index}] {c.source_uri}
                      </span>
                      {c.heading && <span className="text-neutral-400"> — {c.heading}</span>}
                      <p className="mt-1 line-clamp-2 text-neutral-500">{c.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {asking && (
            <div className="mr-auto max-w-[85%] rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-400">
              Thinking…
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleAsk} className="border-t border-neutral-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about a crop, pest, or disease…"
            className="flex-1 rounded-full border border-neutral-300 px-4 py-2.5 text-[15px] outline-none focus:border-green-600"
          />
          <button
            type="submit"
            disabled={asking || !question.trim()}
            className="rounded-full bg-green-700 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </form>

      {drawerOpen && (
        <div className="fixed inset-0 z-20 flex">
          <div className="flex-1 bg-black/30" onClick={() => setDrawerOpen(false)} />
          <div className="flex w-full max-w-sm flex-col bg-white p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">Knowledge sources</h2>
              <button onClick={() => setDrawerOpen(false)} className="text-neutral-500">
                Close
              </button>
            </div>

            <label className="mb-2 block text-sm font-medium text-neutral-700">
              Upload a Word document (.docx)
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
              disabled={uploading}
              className="mb-2 w-full text-sm"
            />
            {uploading && <p className="text-sm text-neutral-500">Ingesting document…</p>}
            {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}

            <div className="mt-4 flex-1 overflow-y-auto">
              <h3 className="mb-2 text-sm font-medium text-neutral-700">Ingested sources</h3>
              {sources.length === 0 && (
                <p className="text-sm text-neutral-400">No sources ingested yet.</p>
              )}
              <ul className="flex flex-col gap-2">
                {sources.map((s) => (
                  <li
                    key={s.source_uri}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 p-2 text-sm"
                  >
                    <div>
                      <p className="font-medium">{s.source_uri}</p>
                      <p className="text-xs text-neutral-400">
                        {s.chunk_count} chunks · {s.source_type}
                      </p>
                    </div>
                    <button onClick={() => handleDeleteSource(s.source_uri)} className="text-xs text-red-600">
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
