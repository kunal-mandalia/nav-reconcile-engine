import { useDataSource } from "./data-source";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type { DisplayStatus, Source } from "@nav/contracts";
import { api, ApiError, type Identity } from "./api";

export const labels: Record<DisplayStatus, string> = {
  no_pack: "No pack",
  processing_pack: "Indexing pack",
  awaiting_documents: "Needs input",
  processing_failed: "Pack failed",
  queued: "Queued",
  running: "Running",
  run_failed: "Run failed",
  matched: "Matched",
  mismatch: "NAV mismatch",
  insufficient_evidence: "Needs input",
  not_run: "Not run",
};
export function Status({ status }: { status: DisplayStatus }) {
  return (
    <span className={`status ${status}`}>
      <span aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
export function Loading({
  message = "Loading reconciliations…",
}: {
  message?: string;
}) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} />
      {message}
    </div>
  );
}
export function ErrorNotice({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  const [remaining, setRemaining] = useState(
    error instanceof ApiError ? error.retryAfter : 0,
  );
  useEffect(() => {
    setRemaining(error instanceof ApiError ? error.retryAfter : 0);
    const timer = setInterval(
      () => setRemaining((n) => Math.max(0, n - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, [error]);
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>{error.message}</strong>
        {error instanceof ApiError && error.requestId && (
          <small>Request {error.requestId}</small>
        )}
        {remaining > 0 && <small>Try again in {remaining}s.</small>}
        {error instanceof ApiError && error.details?.run_id && (
          <Link to={`/runs/${error.details.run_id}`}>
            Open active run <ArrowRight size={13} />
          </Link>
        )}
      </div>
      {retry && (
        <button className="btn" onClick={retry} disabled={remaining > 0}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function DownloadSource({
  identity,
  source,
}: {
  identity: Identity;
  source: Source;
}) {
  const download = useMutation({
    mutationFn: () => api.download(identity, source),
  });
  return (
    <div className="download-action">
      <button
        className="btn"
        onClick={() => download.mutate()}
        disabled={download.isPending}
      >
        {download.isPending ? (
          <LoaderCircle className="spin" size={14} />
        ) : download.isSuccess ? (
          <Check size={14} />
        ) : (
          <Download size={14} />
        )}
        Download source
      </button>
      {download.error && <ErrorNotice error={download.error} />}
    </div>
  );
}
export function Rerun({
  identity,
  fundId,
  periodId,
  fundName,
  packVersion,
  allowed,
  first = false,
}: {
  identity: Identity;
  fundId: string;
  periodId: string;
  fundName: string;
  packVersion: number;
  allowed: boolean;
  first?: boolean;
}) {
  const connection = useDataSource();
  const [open, setOpen] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setCooldown((n) => Math.max(0, n - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const navigate = useNavigate();
  const client = useQueryClient();
  const key = `nav-pending:${identity}:${fundId}:${periodId}`;
  const mutation = useMutation({
    mutationFn: () => {
      // Keep the same key after a lost response, including after a page refresh.
      const requestKey = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, requestKey);
      return api.start(identity, fundId, periodId, requestKey);
    },
    onSuccess: (run) => {
      sessionStorage.removeItem(key);
      client.setQueryData(["run", identity, run.run_id], run);
      void client.invalidateQueries({ queryKey: ["funds", identity] });
      setOpen(false);
      navigate(`/runs/${run.run_id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.retryAfter)
        setCooldown(error.retryAfter);
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      )
        sessionStorage.removeItem(key);
    },
  });
  return (
    <>
      <button
        className="btn primary"
        disabled={!allowed}
        title={
          !allowed
            ? "A run is active or your demo identity has read-only access."
            : undefined
        }
        onClick={() => {
          mutation.reset();
          setOpen(true);
        }}
      >
        <RefreshCw size={14} />
        {first ? "Start reconciliation" : "Rerun"}
      </button>
      {open && (
        <Dialog
          title={first ? "Start reconciliation" : "Rerun reconciliation"}
          close={() => {
            if (!mutation.isPending) setOpen(false);
          }}
        >
          <div className="dialog-body">
            <p>
              Recheck the same pack and create a new run. Earlier decisions and
              their evidence remain unchanged.
            </p>
            <dl className="meta">
              <div>
                <dt>Fund</dt>
                <dd>{fundName}</dd>
              </div>
              <div>
                <dt>Pack version</dt>
                <dd>v{packVersion}</dd>
              </div>
              <div>
                <dt>Reporting date</dt>
                <dd>30 Jun 2026</dd>
              </div>
              <div>
                <dt>Tolerance</dt>
                <dd>0.01 in the fund currency</dd>
              </div>
            </dl>
            <p className="demo-note">
              {connection.status !== "connected"
                ? "The data source is not currently confirmed. Check the connection before starting a run."
                : connection.source === "fund-service"
                  ? "The fund service will read the original source files and reconcile this pack. Earlier results are retained."
                  : "Mock mode simulates processing. With unchanged inputs, the outcome stays the same. No fund service is called."}
            </p>
            {mutation.error && <ErrorNotice error={mutation.error} />}
          </div>
          <div className="dialog-foot">
            <button
              className="btn"
              disabled={mutation.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={mutation.isPending || cooldown > 0}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <RefreshCw size={14} />
              )}
              {cooldown > 0 ? `Wait ${cooldown}s` : "Start run"}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
