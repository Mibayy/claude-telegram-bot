'use strict';

const { execSync } = require('child_process');

const DEFAULT_SERVICES = process.env.MONITOR_SERVICES
  ? process.env.MONITOR_SERVICES.split(',').map(s => s.trim()).filter(Boolean)
  : ['claude-telegram', 'nginx'];

const lastStatus = new Map();
let intervalHandle = null;
let alertCallback = null;
let firstRun = true;

function getServiceStatus(name) {
  try {
    const result = execSync(`systemctl is-active ${name}.service 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    return result.trim() === 'active' ? 'active' : 'inactive';
  } catch (_err) {
    return 'inactive';
  }
}

function checkNow() {
  const results = [];
  const alerts = [];

  for (const name of DEFAULT_SERVICES) {
    const status = getServiceStatus(name);
    const previous = lastStatus.get(name);
    const changed = previous !== undefined && previous !== status;

    results.push({ name, status, changed });

    if (changed && !firstRun) {
      if (status === 'inactive') {
        alerts.push(`\u274C <code>${name}</code> est tomb\u00E9`);
      } else {
        alerts.push(`\u2705 <code>${name}</code> est de retour`);
      }
    }

    lastStatus.set(name, status);
  }

  if (alerts.length > 0 && alertCallback) {
    let message;
    if (alerts.length === 1) {
      const isDown = alerts[0].startsWith('\u274C');
      if (isDown) {
        message = `\uD83D\uDEA8 <b>Service down!</b>\n${alerts[0]}`;
      } else {
        message = `\u2705 <b>Service restored</b>\n${alerts[0]}`;
      }
    } else {
      const hasDown = alerts.some((a) => a.startsWith('\u274C'));
      const hasUp = alerts.some((a) => a.startsWith('\u2705'));
      const titleParts = [];
      if (hasDown) titleParts.push('\uD83D\uDEA8 <b>Service down!</b>');
      if (hasUp) titleParts.push('\u2705 <b>Service restored</b>');
      message = titleParts.join('\n') + '\n' + alerts.join('\n');
    }
    alertCallback(message);
  }

  firstRun = false;
  return results;
}

function start(callback, intervalMs = 60000) {
  if (intervalHandle) {
    stop();
  }
  alertCallback = callback;
  firstRun = true;
  lastStatus.clear();
  checkNow();
  intervalHandle = setInterval(checkNow, intervalMs);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  alertCallback = null;
}

function isRunning() {
  return intervalHandle !== null;
}

function getStatus() {
  const result = {};
  for (const name of DEFAULT_SERVICES) {
    result[name] = lastStatus.get(name) || 'unknown';
  }
  return result;
}

function formatStatus() {
  const lines = [];
  for (const name of DEFAULT_SERVICES) {
    const status = lastStatus.get(name) || 'unknown';
    const icon = status === 'active' ? '\u2705' : '\u274C';
    lines.push(`${icon} <code>${name}</code> \u2014 ${status}`);
  }
  return lines.join('\n');
}

module.exports = {
  start,
  stop,
  isRunning,
  checkNow,
  getStatus,
  formatStatus,
};
