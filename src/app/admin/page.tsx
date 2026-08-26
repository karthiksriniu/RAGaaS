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


export default function AdminHome() {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
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


  useEffect(() => {
    refreshSources(selectedTenantId);
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
      await refreshSources(selectedTenantId);
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
    await refreshSources(selectedTenantId);
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
          <Link href="/admin/numbers">
            <Button type="button" variant="text" icon="dialpad">Phone numbers</Button>
          </Link>
          <Link href="/admin/billing">
            <Button type="button" variant="text" icon="payments">Billing</Button>
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

      </div>
    </div>
  );
}
