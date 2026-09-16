// Popup JavaScript
document.addEventListener('DOMContentLoaded', () => {
  const usernameInput = document.getElementById('username');
  const tweetCountSelect = document.getElementById('tweetCount');
  const checkIntervalSelect = document.getElementById('checkInterval');
  const saveBtn = document.getElementById('saveBtn');
  const checkBtn = document.getElementById('checkBtn');
  const statusMessage = document.getElementById('statusMessage');
  
  // Mevcut ayarları yükle
  loadSettings();
  
  // İstatistikleri yükle
  loadStats();
  
  // Kaydet butonu
  saveBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim().replace(/@/g, '');
    const tweetCount = parseInt(tweetCountSelect.value);
    const checkInterval = parseInt(checkIntervalSelect.value);
    const retweetType = document.querySelector('input[name="retweetType"]:checked')?.value || 'original';
    
    if (!username) {
      showStatus('Lütfen bir kullanıcı adı girin', 'error');
      return;
    }
    
    setButtonLoading(saveBtn, true);
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'saveSettings',
        username: username,
        tweetCount: tweetCount,
        checkInterval: checkInterval,
        retweetType: retweetType
      });
      
      if (response && response.success) {
        showStatus(`Ayarlar kaydedildi! Otomatik kontrol her ${checkInterval} dakikada çalışacak.`, 'success');
        loadStats();
      } else {
        showStatus('Ayarlar kaydedilirken hata oluştu', 'error');
      }
    } catch (error) {
      showStatus('Ayarlar kaydedilirken hata oluştu: ' + error.message, 'error');
    } finally {
      setButtonLoading(saveBtn, false);
    }
  });
  
  // Şimdi kontrol et butonu
  checkBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim().replace(/@/g, '');
    
    if (!username) {
      showStatus('Lütfen önce bir kullanıcı adı girin ve kaydedin', 'error');
      return;
    }
    
    setButtonLoading(checkBtn, true);
    showStatus('Kontrol ediliyor...', 'info');
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'manualCheck'
      });

      // Detaylı sonucu hemen ekrana bas (storage'a yazılmasını beklemeden)
      const stats = response?.stats || response;
      if (stats && (stats.checkedCount !== undefined || stats.retweetedIds !== undefined)) {
        renderLastRun(stats);
      }
      
      if (response && response.success) {
        const s = response.stats || {};
        const detail = `İncelenen: ${s.checkedCount ?? '-'}, Uygun: ${s.eligibleCount ?? '-'}, Gönderilen: ${(s.retweetedIds || []).length}`;
        showStatus(`${response.message} (${detail})`, 'success');
      } else if (response && response.message) {
        const s = response.stats || {};
        if (s.checkedCount !== undefined) {
          showStatus(`${response.message} (İncelenen: ${s.checkedCount}, Uygun: ${s.eligibleCount ?? 0})`, 'error');
        } else {
          showStatus(response.message, 'error');
        }
      } else {
        showStatus('İşlem tamamlanamadı', 'error');
      }
      
      // İstatistikleri güncelle
      setTimeout(() => {
        loadStats();
      }, 1000);
      
    } catch (error) {
      showStatus('Hata: ' + error.message, 'error');
    } finally {
      setButtonLoading(checkBtn, false);
    }
  });
  
  // Enter tuşu ile kaydet
  usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveBtn.click();
    }
  });
});

function loadSettings() {
  chrome.storage.local.get(['targetUsername', 'tweetCount', 'checkInterval', 'retweetType'], (data) => {
    if (data.targetUsername) {
      document.getElementById('username').value = data.targetUsername;
    }
    if (data.tweetCount) {
      document.getElementById('tweetCount').value = data.tweetCount.toString();
    }
    if (data.checkInterval) {
      document.getElementById('checkInterval').value = data.checkInterval.toString();
    }
    if (data.retweetType) {
      const radio = document.querySelector(`input[name="retweetType"][value="${data.retweetType}"]`);
      if (radio) radio.checked = true;
    }
  });
}

function loadStats() {
  chrome.runtime.sendMessage({ action: 'getStats' }, (data) => {
    if (!data) return;
    
    const totalRetweets = data.retweetHistory ? data.retweetHistory.length : 0;
    document.getElementById('totalRetweets').textContent = totalRetweets;

    const totals = data.totalStats || {};
    document.getElementById('totalChecks').textContent = totals.totalChecks ?? 0;
    document.getElementById('totalChecked').textContent = totals.totalChecked ?? 0;
    
    if (data.lastCheck) {
      const lastCheckDate = new Date(data.lastCheck);
      document.getElementById('lastCheck').textContent = formatDate(lastCheckDate);
    } else {
      document.getElementById('lastCheck').textContent = 'Henüz kontrol yapılmadı';
    }
    
    if (data.lastSuccess) {
      const lastSuccessDate = new Date(data.lastSuccess);
      document.getElementById('lastSuccess').textContent = formatDate(lastSuccessDate);
    } else {
      document.getElementById('lastSuccess').textContent = 'Henüz başarılı retweet yok';
    }

    if (data.lastRun) renderLastRun(data.lastRun);
    renderHistory(data.runHistory || []);
  });
}

function modeLabel(mode) {
  if (mode === 'light') return 'Hafif (sekmesiz)';
  if (mode === 'heavy') return 'Klasik (sekmeli)';
  return mode || '-';
}

function triggerLabel(trigger) {
  if (trigger === 'auto') return 'Otomatik';
  if (trigger === 'manual') return 'Manuel';
  return trigger || '-';
}

function renderLastRun(s) {
  if (!s) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('runTime', s.timestamp ? formatDate(new Date(s.timestamp)) + ' (' + new Date(s.timestamp).toLocaleString('tr-TR') + ')' : '-');
  set('runTrigger', triggerLabel(s.trigger));
  set('runMode', modeLabel(s.mode));
  set('runUser', s.username ? '@' + s.username : '-');
  set('runChecked', s.checkedCount ?? 0);
  set('runEligible', s.eligibleCount ?? 0);
  set('runRetweeted', s.retweetedIds ? s.retweetedIds.length : (s.retweetedCount ?? 0));
  set('runSkipped', `${s.skippedAlready ?? 0} / ${s.skippedReply ?? 0} / ${s.skippedRepost ?? 0} / ${s.skippedAd ?? 0}`);
  set('runDuration', s.durationMs ? (s.durationMs / 1000).toFixed(1) + ' sn' : '-');
  set('runMessage', (s.success ? '✅ ' : 'ℹ️ ') + (s.message || '-'));
  set('runIds', s.retweetedIds && s.retweetedIds.length ? s.retweetedIds.join(', ') : '-');
}

function renderHistory(history) {
  const box = document.getElementById('runHistoryList');
  if (!box) return;
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<div class="help-text">Henüz kontrol geçmişi yok.</div>';
    return;
  }
  history.slice(0, 10).forEach(h => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const time = h.timestamp ? new Date(h.timestamp).toLocaleString('tr-TR') : '-';
    const ids = h.retweetedIds && h.retweetedIds.length ? `<br>ID: ${h.retweetedIds.join(', ')}` : '';
    row.innerHTML = `<strong>${time}</strong> · ${triggerLabel(h.trigger)} · ${modeLabel(h.mode)} · @${h.username || '-'}<br>` +
      `İncelenen: <strong>${h.checkedCount ?? 0}</strong> · Uygun: <strong>${h.eligibleCount ?? 0}</strong> · Gönderilen: <strong>${h.retweetedIds ? h.retweetedIds.length : 0}</strong>${ids}`;
    box.appendChild(row);
  });
}

function showStatus(message, type) {
  const statusEl = document.getElementById('statusMessage');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  
  if (type !== 'info') {
    setTimeout(() => {
      statusEl.className = 'status';
    }, 5000);
  }
}

function setButtonLoading(button, isLoading) {
  if (isLoading) {
    button.classList.add('loading');
    button.disabled = true;
  } else {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) {
    return 'Az önce';
  } else if (minutes < 60) {
    return `${minutes} dakika önce`;
  } else if (hours < 24) {
    return `${hours} saat önce`;
  } else if (days < 7) {
    return `${days} gün önce`;
  } else {
    return date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}
