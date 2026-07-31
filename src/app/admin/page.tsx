"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { Select } from "@/components/kiowa/Select";
import { Card } from "@/components/kiowa/Card";
import { ListItem } from "@/components/kiowa/ListItem";
import { IconButton } from "@/components/kiowa/IconButton";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";
import { StatusPill } from "@/components/kiowa/StatusPill";
import { Logo } from "@/components/Logo";

interface SourceRow {
  source_uri: string;
  source_type: string;
  chunk_count: number;
  ingested_at: string;
}

interface TenantOption {
  id: string;
  name: string;
}

type SyncState = "never_uploaded" | "in_sync" | "needs_upload";

interface DerivedKb {
  document: string;
  description: string;
  systemPromptAddendum: string | null;
  contentHash: string;
  stats: { sourceCount: number; chunkCount: number; characterCount: number };
  sync: SyncState;
  uploadedAt: string | null;
}

export default function AdminHome() {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [derivedKb, setDerivedKb] = useState<DerivedKb | null>(null);
  const [derivedKbLoading, setDerivedKbLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function refreshTenants() {
    const res = await fetch("/api/admin/tenants");
    if (res.status === 401) {
      router.push("/admin/login");
      return;
    }
    const data = await res.json();
    const list: TenantOption[] = data.tenants || [];
    setTenants(list);
    setSelectedTenantId((current) => current || list[0]?.id || "");
  }

  async function refreshSources(tenantId: string) {
    if (!tenantId) {
      setSources([]);
      return;
    }
    const res = await fetch(`/api/admin/ingest?tenantId=${encodeURIComponent(tenantId)}`);
    if (res.status === 401) {
      router.push("/admin/login");
      return;
    }
    const data = await res.json();
    setSources(data.sources || []);
  }

  useEffect(() => {
    refreshTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshDerivedKb(tenantId: string) {
    if (!tenantId) {
      setDerivedKb(null);
      return;
    }
    setDerivedKbLoading(true);
    try {
      const res = await fetch(`/api/admin/derived-kb?tenantId=${encodeURIComponent(tenantId)}`);
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      if (!res.ok) {
        setDerivedKb(null);
        return;
      }
      setDerivedKb(await res.json());
    } finally {
      setDerivedKbLoading(false);
    }
  }

  useEffect(() => {
    refreshSources(selectedTenantId);
    refreshDerivedKb(selectedTenantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenantId]);

  async function handleUpload(file: File) {
    if (!selectedTenantId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("tenantId", selectedTenantId);
      const res = await fetch("/api/admin/ingest", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      // The derived artifacts are a pure function of the tenant's chunks, so
      // any ingest invalidates them - regenerate immediately rather than
      // leaving the admin looking at a stale document.
      await Promise.all([refreshSources(selectedTenantId), refreshDerivedKb(selectedTenantId)]);
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
      body: JSON.stringify({ sourceUri, tenantId: selectedTenantId }),
    });
    await Promise.all([refreshSources(selectedTenantId), refreshDerivedKb(selectedTenantId)]);
  }

  async function handleCopy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
  }

  function handleDownload() {
    if (!selectedTenantId) return;
    window.location.href = `/api/admin/derived-kb?tenantId=${encodeURIComponent(selectedTenantId)}&download=1`;
  }

  async function handleMarkUploaded() {
    if (!selectedTenantId || !derivedKb) return;
    await fetch("/api/admin/derived-kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Send the hash the browser was shown, so this can never mark a newer
      // state than what the admin actually copied into Sarvam.
      body: JSON.stringify({ tenantId: selectedTenantId, contentHash: derivedKb.contentHash }),
    });
    await refreshDerivedKb(selectedTenantId);
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
  }

  const tenantOptions = tenants.map((t) => ({ value: t.id, label: t.name }));

  return (
    <div className="min-h-screen" style={{ background: "var(--color-surface)", color: "var(--color-on-surface)" }}>
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-lowest)" }}
      >
        <div className="flex items-center gap-2.5">
          <Logo size={28} />
          <h1 className="kw-title-large" style={{ fontFamily: "var(--font-brand)", fontWeight: "var(--weight-bold)", color: "var(--color-primary)" }}>
            MyBizCare admin
          </h1>
          <StatusPill label="Knowledge sources" tone="neutral" />
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/tenants">
            <Button type="button" variant="text" icon="group">Manage tenants</Button>
          </Link>
          <Button type="button" variant="outlined" icon="logout" onClick={handleLogout}>Sign out</Button>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-8">
        <Select
          label="Tenant"
          value={selectedTenantId}
          options={tenantOptions.length ? tenantOptions : [{ value: "", label: "No tenants yet" }]}
          onChange={setSelectedTenantId}
          style={{ marginBottom: 24, width: "100%" }}
        />

        <p className="kw-label-large mb-2" style={{ color: "var(--color-on-surface-variant)" }}>
          Upload a Word document (.docx)
        </p>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="tonal"
            icon="upload_file"
            disabled={uploading || !selectedTenantId}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose file
          </Button>
          {uploading && (
            <span className="flex items-center gap-2 kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
              <ProgressIndicator variant="circular" size={16} thickness={2} />
              Ingesting document…
            </span>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".docx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
          disabled={uploading || !selectedTenantId}
          className="hidden"
        />
        {uploadError && (
          <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
            {uploadError}
          </p>
        )}

        <div className="mt-10">
          <h2 className="kw-label-large mb-3" style={{ color: "var(--color-on-surface-variant)" }}>
            Ingested sources
          </h2>
          {sources.length === 0 && (
            <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
              No sources ingested yet.
            </p>
          )}
          {sources.length > 0 && (
            <Card variant="outlined" padding={0}>
              {sources.map((s, i) => (
                <div key={s.source_uri} style={{ borderTop: i === 0 ? "none" : "1px solid var(--color-outline-variant)" }}>
                  <ListItem
                    leadingIcon="description"
                    headline={s.source_uri}
                    supportingText={`${s.chunk_count} chunks · ${s.source_type}`}
                    trailing={
                      <IconButton
                        icon="delete"
                        variant="standard"
                        aria-label={`Delete ${s.source_uri}`}
                        onClick={() => handleDeleteSource(s.source_uri)}
                        style={{ color: "var(--color-error)" }}
                      />
                    }
                  />
                </div>
              ))}
            </Card>
          )}
        </div>

        <div className="mt-10">
          <div className="mb-1 flex items-center gap-3">
            <h2 className="kw-label-large" style={{ color: "var(--color-on-surface-variant)" }}>
              Files to upload to Sarvam
            </h2>
            {derivedKbLoading && <ProgressIndicator variant="circular" size={14} thickness={2} />}
            {!derivedKbLoading && derivedKb && derivedKb.sync === "in_sync" && (
              <StatusPill label="In sync" tone="success" />
            )}
            {!derivedKbLoading && derivedKb && derivedKb.sync === "needs_upload" && (
              <StatusPill label="Re-upload needed" tone="urgent" />
            )}
            {!derivedKbLoading && derivedKb && derivedKb.sync === "never_uploaded" && (
              <StatusPill label="Not yet uploaded" tone="neutral" />
            )}
          </div>

          <p className="kw-body-small mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
            Regenerated automatically whenever this tenant&apos;s sources or answer style change.
            Sarvam has no knowledge-base API, so the upload itself is a manual step in their
            dashboard.
          </p>

          {!derivedKb && !derivedKbLoading && (
            <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
              Nothing to upload yet — ingest a source first.
            </p>
          )}

          {derivedKb && (
            <Card variant="outlined" padding={20}>
              {derivedKb.sync !== "in_sync" && (
                <div
                  className="mb-4 flex items-start gap-2 rounded-lg p-3"
                  style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
                    upload_file
                  </span>
                  <p className="kw-body-small">
                    {derivedKb.sync === "never_uploaded"
                      ? "Upload these three items into the Sarvam agent, then mark them as uploaded."
                      : "This tenant's knowledge base changed since the last upload. Re-upload all three items into Sarvam, then mark them as uploaded."}
                  </p>
                </div>
              )}

              <p className="kw-label-large mb-1">1 · Knowledge source file</p>
              <p className="kw-body-small mb-2" style={{ color: "var(--color-on-surface-variant)" }}>
                {derivedKb.stats.sourceCount} sources · {derivedKb.stats.chunkCount} chunks ·{" "}
                {derivedKb.stats.characterCount.toLocaleString()} characters. Replace the existing
                file in Sarvam rather than adding a second one.
              </p>
              <Button variant="tonal" size="small" icon="download" onClick={handleDownload}>
                Download .md
              </Button>

              <p className="kw-label-large mt-6 mb-1">2 · Knowledge base description</p>
              <p className="kw-body-small mb-2" style={{ color: "var(--color-on-surface-variant)" }}>
                Paste into the KB&apos;s Description field — Sarvam routes on this text.
              </p>
              <pre
                className="kw-body-small mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg p-3"
                style={{ background: "var(--color-surface-container-highest)" }}
              >
                {derivedKb.description}
              </pre>
              <Button
                variant="outlined"
                size="small"
                icon={copied === "description" ? "check" : "content_copy"}
                onClick={() => handleCopy("description", derivedKb.description)}
              >
                {copied === "description" ? "Copied" : "Copy description"}
              </Button>

              <p className="kw-label-large mt-6 mb-1">3 · Agent system prompt addendum</p>
              <p className="kw-body-small mb-2" style={{ color: "var(--color-on-surface-variant)" }}>
                Append to the agent&apos;s system prompt. Deliberately not in the file — knowledge
                base content only surfaces when it matches the caller&apos;s question, so style
                rules there would apply erratically.
              </p>
              {derivedKb.systemPromptAddendum ? (
                <>
                  <pre
                    className="kw-body-small mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg p-3"
                    style={{ background: "var(--color-surface-container-highest)" }}
                  >
                    {derivedKb.systemPromptAddendum}
                  </pre>
                  <Button
                    variant="outlined"
                    size="small"
                    icon={copied === "prompt" ? "check" : "content_copy"}
                    onClick={() => handleCopy("prompt", derivedKb.systemPromptAddendum || "")}
                  >
                    {copied === "prompt" ? "Copied" : "Copy addendum"}
                  </Button>
                </>
              ) : (
                <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                  No answer style configured for this tenant — nothing to add.{" "}
                  <Link href="/admin/tenants" style={{ color: "var(--color-primary)" }}>
                    Set one
                  </Link>
                </p>
              )}

              <div
                className="mt-6 flex flex-wrap items-center gap-3 pt-4"
                style={{ borderTop: "1px solid var(--color-outline-variant)" }}
              >
                <Button
                  variant="filled"
                  size="small"
                  icon="cloud_done"
                  disabled={derivedKb.sync === "in_sync"}
                  onClick={handleMarkUploaded}
                >
                  {derivedKb.sync === "in_sync" ? "Marked as uploaded" : "Mark as uploaded to Sarvam"}
                </Button>
                {derivedKb.uploadedAt && (
                  <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                    Last uploaded {new Date(derivedKb.uploadedAt).toLocaleString()}
                  </span>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
