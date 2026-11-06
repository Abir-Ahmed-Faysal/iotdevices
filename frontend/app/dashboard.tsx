"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Image from "next/image";

type DeviceStatus = {
  name?: string;
  deviceId?: string;
  state?: "on" | "off" | "unknown";
  ip?: string;
  uptime?: number | null;
  online?: boolean;
  transport?: "mqtt" | "local";
  lastSeen?: string | null;
  activityWarning?: string;
};

type Activity = {
  id: string;
  eventType: string;
  message: string;
  createdAt: string;
};

type RuntimeDay = {
  day: number;
  onlineSeconds: number;
  relayOnSeconds: number;
};

type RuntimeMonth = {
  key: string;
  label: string;
  daysInMonth: number;
  throughDay: number;
  days: RuntimeDay[];
};

const ACTIVITY_PAGE_SIZE = 50;

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  if (response.status === 204) {
    return null as T;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.") as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return data as T;
}

function formatUptime(seconds?: number | null) {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) {
    return "-";
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return days > 0
    ? `${days}d ${hours}h ${minutes}m`
    : `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function clockLabel() {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
}

function RuntimeChart({ month }: { month: RuntimeMonth }) {
  const visibleDays = Math.min(month.daysInMonth, Math.max(1, month.throughDay));
  const values = Array.from({ length: visibleDays }, (_, index) => {
    const saved = month.days.find((item) => item.day === index + 1);
    return {
      day: index + 1,
      onlineSeconds: saved?.onlineSeconds ?? 0,
      relayOnSeconds: saved?.relayOnSeconds ?? 0,
    };
  });
  let onlineTotal = 0;
  let relayOnTotal = 0;
  const cumulative = values.map((value) => {
    onlineTotal += value.onlineSeconds;
    relayOnTotal += value.relayOnSeconds;
    return {
      day: value.day,
      onlineHours: onlineTotal / 3600,
      relayOnHours: relayOnTotal / 3600,
    };
  });
  const maxHours = Math.max(1, ...cumulative.map((value) => value.onlineHours));
  const chartWidth = 620;
  const chartHeight = 210;
  const left = 46;
  const right = 12;
  const top = 14;
  const bottom = 32;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const x = (day: number) => left + ((day - 1) / Math.max(1, visibleDays - 1)) * plotWidth;
  const y = (hours: number) => top + plotHeight - (hours / maxHours) * plotHeight;
  const pointList = (field: "onlineHours" | "relayOnHours") => cumulative
    .map((value) => `${x(value.day)},${y(value[field])}`)
    .join(" ");
  const dateLabels = [...new Set([1, 7, 14, 21, 28, visibleDays])].filter(
    (day) => day <= visibleDays,
  );
  const onlineTotalSeconds = values.reduce((total, value) => total + value.onlineSeconds, 0);
  const relayOnTotalSeconds = values.reduce((total, value) => total + value.relayOnSeconds, 0);

  return (
    <article className="runtime-month">
      <h3>{month.label}</h3>
      <div className="runtime-totals">
        <div><span className="runtime-key runtime-key-online" />Online <strong>{formatUptime(onlineTotalSeconds)}</strong></div>
        <div><span className="runtime-key runtime-key-relay" />Relay ON <strong>{formatUptime(relayOnTotalSeconds)}</strong></div>
      </div>
      <div className="runtime-chart-scroll">
        <svg
          className="runtime-chart"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-label={`${month.label} cumulative observed online and relay-on hours`}
        >
        {[0, 0.5, 1].map((fraction) => {
          const hours = maxHours * fraction;
          const lineY = y(hours);
          return (
            <g key={fraction}>
              <line x1={left} x2={chartWidth - right} y1={lineY} y2={lineY} className="chart-gridline" />
              <text x={left - 8} y={lineY + 4} textAnchor="end" className="chart-label">{hours.toFixed(hours < 1 ? 1 : 0)}h</text>
            </g>
          );
        })}
        <polyline points={pointList("onlineHours")} className="chart-line chart-line-online" />
        <polyline points={pointList("relayOnHours")} className="chart-line chart-line-relay" />
        {cumulative.map((value) => (
          <g key={value.day}>
            <circle cx={x(value.day)} cy={y(value.onlineHours)} r="2.5" className="chart-point chart-point-online" />
            <circle cx={x(value.day)} cy={y(value.relayOnHours)} r="2.5" className="chart-point chart-point-relay" />
          </g>
        ))}
        {dateLabels.map((day) => {
          return <text key={day} x={x(day)} y={chartHeight - 8} textAnchor="middle" className="chart-label">{day}</text>;
        })}
        </svg>
      </div>
    </article>
  );
}

export default function Dashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [loginMessage, setLoginMessage] = useState("");
  const [deviceMessage, setDeviceMessage] = useState("");
  const [activityMessage, setActivityMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState("");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [runtimeMonths, setRuntimeMonths] = useState<RuntimeMonth[]>([]);
  const [runtimeMessage, setRuntimeMessage] = useState("");

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await request<DeviceStatus>("/api/device/status");
      setStatus(nextStatus);
      if (nextStatus.activityWarning) setActivityMessage(nextStatus.activityWarning);
      setDeviceMessage("");
    } catch (error) {
      const requestError = error as Error & { status?: number };
      if (requestError.status === 401) {
        setAuthenticated(false);
        return;
      }
      setDeviceMessage(requestError.message);
      setStatus((previous) => previous ? { ...previous, online: false } : null);
    }
  }, []);

  const refreshActivity = useCallback(async (warning = "") => {
    try {
      const result = await request<{ activity: Activity[]; nextCursor: string | null }>("/api/activity");
      setActivity((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of result.activity) merged.set(item.id, item);
        return [...merged.values()]
          .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
          .slice(0, Math.max(ACTIVITY_PAGE_SIZE, current.length));
      });
      if (!activityExpanded) setActivityCursor(result.nextCursor);
      setActivityMessage(warning);
    } catch (error) {
      setActivityMessage((error as Error).message);
    }
  }, [activityExpanded]);

  const refreshRuntime = useCallback(async () => {
    try {
      const result = await request<{ months: RuntimeMonth[] }>("/api/device/runtime");
      setRuntimeMonths(result.months);
      setRuntimeMessage("");
    } catch (error) {
      setRuntimeMessage((error as Error).message);
    }
  }, []);

  async function loadOlderActivity() {
    if (!activityCursor || activityLoadingMore) return;
    setActivityLoadingMore(true);
    try {
      const result = await request<{ activity: Activity[]; nextCursor: string | null }>(
        `/api/activity?cursor=${encodeURIComponent(activityCursor)}`,
      );
      setActivity((current) => [...current, ...result.activity]);
      setActivityCursor(result.nextCursor);
    } catch (error) {
      setActivityMessage((error as Error).message);
    } finally {
      setActivityLoadingMore(false);
    }
  }

  useEffect(() => {
    setClock(clockLabel());
    const clockTimer = window.setInterval(() => setClock(clockLabel()), 60_000);
    request<{ username: string }>("/api/auth/me")
      .then((user) => {
        setAuthenticated(true);
        setUsername(user.username);
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setCheckingSession(false));
    return () => window.clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    void refreshStatus();
    void refreshActivity();
    void refreshRuntime();
    const statusTimer = window.setInterval(() => void refreshStatus(), 15000);
    const activityTimer = window.setInterval(() => void refreshActivity(), 15000);
    const runtimeTimer = window.setInterval(() => void refreshRuntime(), 15000);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(activityTimer);
      window.clearInterval(runtimeTimer);
    };
  }, [authenticated, refreshActivity, refreshRuntime, refreshStatus]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginMessage("");
    setBusy(true);
    try {
      const user = await request<{ username: string; activityWarning?: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setUsername(user.username);
      setPassword("");
      setAuthenticated(true);
      await refreshActivity(user.activityWarning);
    } catch (error) {
      setLoginMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await request("/api/auth/logout", { method: "POST" });
      setAuthenticated(false);
      setStatus(null);
      setActivity([]);
      setActivityCursor(null);
      setActivityExpanded(false);
      setRuntimeMonths([]);
    } catch (error) {
      setDeviceMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setDeviceState(action: "on" | "off") {
    setBusy(true);
    setDeviceMessage("");
    try {
      const nextStatus = await request<DeviceStatus>(`/api/device/${action}`, {
        method: "POST",
      });
      setStatus(nextStatus);
      await refreshActivity(nextStatus.activityWarning);
    } catch (error) {
      setDeviceMessage((error as Error).message);
    } finally {
      setBusy(false);
      await refreshStatus();
    }
  }

  const online = status?.online === true;
  const state = status?.state || "unknown";
  const connectionType = online
    ? status?.transport === "mqtt" ? "Cloud MQTT" : "Local Wi-Fi"
    : "Disconnected";

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FishVoice IoT home">
          <Image className="brand-logo" src="/fishvoice-logo.png" width={768} height={768} alt="" priority />
          <span><strong>FishVoice</strong><small>IoT Control</small></span>
        </a>
        <div className="topbar-status">
          <span className={`dot ${online ? "dot-online" : authenticated ? "dot-offline" : "dot-muted"}`} />
          <span>{checkingSession ? "Checking session" : online ? "Connected" : authenticated ? "Device offline" : "Secure dashboard"}</span>
          <span className="divider" aria-hidden="true" />
          <span id="clock">{clock || "FishVoice IoT"}</span>
        </div>
      </header>

      {checkingSession ? (
        <section className="loading-view" aria-live="polite">
          <span className="loading-spinner" />
          <p>Loading your secure dashboard…</p>
        </section>
      ) : !authenticated ? (
        <section className="login-view">
          <div className="login-card">
            <Image className="brand-logo brand-logo-large" src="/fishvoice-logo.png" width={768} height={768} alt="" priority />
            <p className="eyebrow">PRIVATE DEVICE DASHBOARD</p>
            <h1>Welcome back</h1>
            <p className="muted">Sign in to control your FishVoice IoT device.</p>
            <form onSubmit={signIn}>
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button className="button button-primary login-button" type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
            <p className="message" role="status">{loginMessage}</p>
          </div>
        </section>
      ) : (
        <>
          <div className="page-heading">
            <div>
              <p className="eyebrow">DEVICE OVERVIEW</p>
              <h1>FishVoice IoT Relay Controller</h1>
              <p className="muted">Control and monitor your device securely.</p>
            </div>
            <button className="button button-quiet" type="button" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          </div>

          <section className="summary-grid" aria-label="Device summary">
            <article className="summary-card">
              <span className="summary-icon icon-green" aria-hidden="true">⌁</span>
              <div><span className="card-label">Connection</span><strong>{online ? "Online" : "Offline"}</strong><small>{online ? "Connected to device" : "Waiting for device"}</small></div>
            </article>
            <article className="summary-card">
              <span className="summary-icon icon-blue" aria-hidden="true">⌖</span>
              <div><span className="card-label">IP address</span><strong>{status?.ip || "-"}</strong><small>Device network address</small></div>
            </article>
            <article className="summary-card">
              <span className="summary-icon icon-purple" aria-hidden="true">◷</span>
              <div><span className="card-label">Uptime</span><strong>{formatUptime(status?.uptime)}</strong><small>Since last restart</small></div>
            </article>
            <article className="summary-card">
              <span className="summary-icon icon-amber" aria-hidden="true">ϟ</span>
              <div><span className="card-label">Output state</span><strong>{state.toUpperCase()}</strong><small>GPIO4 · relay not connected</small></div>
            </article>
          </section>

          <section className="control-card">
            <div className="control-heading">
              <div><p className="eyebrow">DEVICE CONTROL</p><h2>Relay output</h2><p className="muted">Choose an action. The device starts OFF after a restart.</p></div>
              <span className={`badge ${online ? "badge-online" : "badge-muted"}`}>{online ? "Ready" : "Offline"}</span>
            </div>
            <div className="control-content">
              <div className="button-row">
                <button className="button button-on" type="button" disabled={!online || busy} onClick={() => void setDeviceState("on")}><span aria-hidden="true">⏻</span> Turn ON</button>
                <button className="button button-off" type="button" disabled={!online || busy} onClick={() => void setDeviceState("off")}><span aria-hidden="true">⏻</span> Turn OFF</button>
              </div>
              <div className="current-state">
                <span className={`state-icon ${state === "on" ? "state-on" : ""}`} aria-hidden="true">{online ? "✓" : "○"}</span>
                <div><span className="card-label">Currently</span><strong>{state.toUpperCase()}</strong><small>{status?.lastSeen ? `Last update ${new Date(status.lastSeen).toLocaleTimeString()}` : "No device update yet"}</small></div>
              </div>
            </div>
            <p className="message" role="status">{deviceMessage}</p>
          </section>

          <section className="runtime-section" aria-label="Device runtime history">
            <div className="section-heading">
              <div>
                <p className="eyebrow">RUNTIME HISTORY</p>
                <h2>Monthly uptime</h2>
                <p className="muted">Cumulative online and relay-ON time by day, for this month and last month.</p>
              </div>
            </div>
            {runtimeMessage && <p className="message" role="status">{runtimeMessage}</p>}
            <div className="runtime-grid">
              {runtimeMonths.map((month) => <RuntimeChart key={month.key} month={month} />)}
            </div>
            <p className="runtime-note">Estimated from successful status checks while this dashboard is open. Gaps longer than 30 seconds are not counted. Historical time before tracking was deployed cannot be backfilled.</p>
          </section>

          <section className="details-grid">
            <article className="panel">
              <h2><span className="panel-icon" aria-hidden="true">▦</span> Device information</h2>
              <dl className="info-list">
                <div><dt>Device name</dt><dd>{status?.name || "Faysal IoT"}</dd></div>
                <div><dt>Device ID</dt><dd>{status?.deviceId || "-"}</dd></div>
                <div><dt>Connection</dt><dd>{connectionType}</dd></div>
                <div><dt>ESP32 chip</dt><dd>ESP32-D0WD-V3</dd></div>
              </dl>
            </article>
            <article className="panel">
              <div className="activity-heading">
                <h2><span className="panel-icon" aria-hidden="true">◷</span> Activity</h2>
                <button className="text-button" type="button" onClick={() => setActivityExpanded((expanded) => !expanded)}>
                  {activityExpanded ? "Show recent" : "See all"}
                </button>
              </div>
              {activityMessage && <p className="message" role="status">{activityMessage}</p>}
              <ol className="activity-log" aria-live="polite">
                {activity.length === 0
                  ? <li className="empty-activity">{activityMessage ? "Activity could not be loaded." : "No activity recorded yet."}</li>
                  : (activityExpanded ? activity : activity.slice(0, 5)).map((item) => (
                    <li key={item.id}><span className="activity-dot" /><time>{new Date(item.createdAt).toLocaleString()}</time><span>{item.message}</span></li>
                  ))}
              </ol>
              {activityExpanded && activityCursor && (
                <button className="text-button load-older-button" type="button" onClick={() => void loadOlderActivity()} disabled={activityLoadingMore}>
                  {activityLoadingMore ? "Loading…" : "Load older"}
                </button>
              )}
            </article>
            <article className="panel connection-panel">
              <h2><span className="panel-icon" aria-hidden="true">▥</span> Link status</h2>
              <div className="link-indicator" aria-hidden="true">⌁</div>
              <strong>{online ? "Device is online" : "Device is offline"}</strong>
              <p className="muted">{status?.lastSeen ? `Last update ${new Date(status.lastSeen).toLocaleTimeString()}` : "Status updates appear here."}</p>
            </article>
          </section>
          <footer>FishVoice IoT · Secure sign-in required · No relay module connected yet</footer>
        </>
      )}
    </main>
  );
}
