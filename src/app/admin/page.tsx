"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SourceRow {
  source_uri: string;
  source_type: string;
  chunk_count: number;
  ingested_at: string;
}

export default function AdminHome() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function refreshSources() {
    const res = await fetch("/api/admin/ingest");
    if (res.status === 401) {
      router.push("/admin/login");
      return;
    }
    const data = await res.json();
    setSources(data.sources || []);
  }

  useEffect(() => {
    refreshSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/admin/ingest", { method: "POST", body: formData });
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
    await fetch("/api/admin/ingest", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUri }),
    });
    await refreshSources();
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-green-800">AgriAdvisor admin</h1>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
            Knowledge sources
          </span>
        </div>
        <button onClick={handleLogout} className="text-sm text-neutral-500 hover:text-neutral-800">
          Sign out
        </button>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-8">
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

        <div className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-neutral-700">Ingested sources</h2>
          {sources.length === 0 && (
            <p className="text-sm text-neutral-400">No sources ingested yet.</p>
          )}
          <ul className="flex flex-col gap-2">
            {sources.map((s) => (
              <li
                key={s.source_uri}
                className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 text-sm"
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
  );
}
