// Background Service Worker

// Hafif mod (Fx API + GraphQL) KAPALI: X queryId'leri döndürdükçe GraphQL
// 404 veriyor, uygun tweet bulunsa bile gönderemiyor. Sadece heavy (sekmeli)
// mod kullanılıyor. Açmak için true yap.
const USE_LIGHT_MODE = false;

chrome.runtime.onInstalled.addListener(() => {
  console.log('Twitter Auto Retweet eklentisi yüklendi');
  
  // Varsayılan ayarları yükle ve alarm kur
  chrome.storage.local.get(['checkInterval'], (data) => {
    const interval = data.checkInterval || 60;
    chrome.alarms.create('checkTweets', {
      periodInMinutes: interval
    });
    console.log(`Alarm kuruldu: Her ${interval} dakikada`);
  });
});

// Alarm tetiklendiğinde
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkTweets') {
    console.log('Otomatik kontrol başlatılıyor...');
    try {
      const result = await checkAndRetweet('auto');
      console.log('Otomatik kontrol tamamlandı:', result);
    } catch (error) {
      console.error('Otomatik kontrol hatası:', error);
    }
  }
});

// Manuel kontrol için mesaj dinleyici
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'manualCheck') {
    checkAndRetweet('manual').then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, message: 'Hata: ' + error.message });
    });
    return true; // Asenkron yanıt için
  }
  
  if (request.action === 'getStats') {
    chrome.storage.local.get(['retweetHistory', 'targetUsername', 'lastCheck', 'lastSuccess', 'tweetCount', 'retweetType', 'checkInterval', 'lastRun', 'runHistory', 'totalStats'], (data) => {
      sendResponse(data);
    });
    return true;
  }
  
  if (request.action === 'saveSettings') {
    const checkInterval = request.checkInterval || 60;
    const retweetType = request.retweetType || 'both';
    const cleanUsername = String(request.username || '').trim().replace(/@/g, '');
    
    chrome.storage.local.set({
      targetUsername: cleanUsername,
      tweetCount: request.tweetCount || 1,
      checkInterval: checkInterval,
      retweetType: retweetType
    }, () => {
      // Alarm'ı yeniden kur
      chrome.alarms.clear('checkTweets', () => {
        chrome.alarms.create('checkTweets', {
          periodInMinutes: checkInterval
        });
        console.log(`Alarm güncellendi: Her ${checkInterval} dakikada`);
      });
      
      sendResponse({ success: true });
    });
    return true;
  }
});

// ---- Hafif mod (fetch-based): sekme açmadan çalışır ----
// Okuma: ücretsiz FxTwitter public API (auth gerektirmez)
// Yazma: X web GraphQL CreateRetweet (loginli cookie'leri kullanır, ücretli API değil)
const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
// queryId'ler X tarafından periyodik döndürülür. Birincil + yedek liste dene, çalışanı cache'le.
const RETWEET_QUERY_IDS = ['LFho5rIi4xcKO90p9jwG7A'];
const X_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_composer_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_elongated_highlights_enabled: false,
  responsive_web_free_article_data_collection_enabled: false,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_enhance_cards_enabled: false
};

function normalizeUsername(u) {
  return String(u || '').trim().replace(/@/g, '').toLowerCase();
}

function extractTweetIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

// Fx API bazen {type:'thread', thread:[status,...]} döner. Üst seviye id'siz
// kayıtları eleyip düz status listesine çevirir. Ücretli API yok, sadece şekil düzeltme.
function flattenFxResults(results) {
  const flat = [];
  for (const entry of (results || [])) {
    if (!entry) continue;
    if (Array.isArray(entry.thread) && entry.thread.length) {
      for (const inner of entry.thread) {
        if (inner && (inner.id || inner.tweetID)) {
          if (!inner.id && inner.tweetID) inner.id = String(inner.tweetID);
          flat.push(inner);
        }
      }
      continue;
    }
    if (entry.status && (entry.status.id || entry.status.tweetID)) {
      const s = entry.status;
      if (!s.id && s.tweetID) s.id = String(s.tweetID);
      flat.push(s);
      continue;
    }
    if (entry.id || entry.tweetID) {
      if (!entry.id && entry.tweetID) entry.id = String(entry.tweetID);
      // type:'status' ya da tipsiz düz kayıt
      flat.push(entry);
      continue;
    }
    // id'siz thread/tombstone gibi kayıtları sessizce atla (sayaç dışında)
  }
  return flat;
}

async function fetchTimelineViaFx(username, count = 10) {
  const url = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(username)}/statuses?count=${Math.min(Math.max(count, 1), 20)}`;
  const res = await fetch(url, { method: 'GET' });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`Fx API hata: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 200) throw new Error(`Fx API hata: ${data.code} ${data.message || ''}`);
  return flattenFxResults(data.results || []);
}

async function getXCookies() {
  const ct0 = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
  const authToken = await chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' });
  if (!ct0?.value || !authToken?.value) {
    throw new Error('X oturumu bulunamadı. Önce x.com\'da giriş yapın (hafif mod cookie gerektirir).');
  }
  return { ct0: ct0.value, authToken: authToken.value };
}

async function retweetViaGraphQL(tweetId) {
  const { ct0 } = await getXCookies();
  const stored = await chrome.storage.local.get(['workingRetweetQueryId']);
  const queryIds = [
    ...(stored.workingRetweetQueryId ? [stored.workingRetweetQueryId] : []),
    ...RETWEET_QUERY_IDS
  ].filter((v, i, a) => a.indexOf(v) === i);

  let lastError = null;
  for (const qid of queryIds) {
    try {
      const res = await fetch(`https://x.com/i/api/graphql/${qid}/CreateRetweet`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'authorization': `Bearer ${X_BEARER}`,
          'content-type': 'application/json',
          'x-csrf-token': ct0,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-client-language': 'tr'
        },
        body: JSON.stringify({
          variables: { tweet_id: tweetId, dark_request: false },
          features: X_FEATURES,
          queryId: qid
        })
      });

      if (res.status === 404) {
        lastError = new Error(`queryId geçersiz (404): ${qid}`);
        continue; // sonraki queryId'yi dene
      }
      if (res.status === 403 || res.status === 429) {
        const txt = await res.text().catch(() => '');
        throw new Error(`X isteği engellendi (HTTP ${res.status}). Rate-limit / bot koruması olabilir. ${txt.slice(0, 120)}`);
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`GraphQL HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => ({}));
      if (data.errors) {
        throw new Error(`GraphQL hata: ${JSON.stringify(data.errors).slice(0, 200)}`);
      }
      // Başarılı -> çalışan queryId'yi cache'le
      await chrome.storage.local.set({ workingRetweetQueryId: qid });
      return { ok: true, queryId: qid };
    } catch (e) {
      lastError = e;
      // 404 dışında auth/rate-limit hatasında diğer ID'yi denemenin anlamı yok
      if (!String(e.message).includes('404')) throw e;
    }
  }
  throw lastError || new Error('Retweet GraphQL çağrısı başarısız');
}

async function saveRetweetsToHistory(targetUsername, retweetedIds) {
  const stored = await chrome.storage.local.get(['retweetHistory']);
  const retweetHistory = stored.retweetHistory || [];
  retweetedIds.forEach(tweetId => {
    retweetHistory.push({ tweetId, username: targetUsername, timestamp: new Date().toISOString() });
  });
  if (retweetHistory.length > 200) retweetHistory.splice(0, retweetHistory.length - 200);
  await chrome.storage.local.set({
    retweetHistory,
    lastCheck: new Date().toISOString(),
    lastSuccess: new Date().toISOString()
  });
}

// Detaylı sayaç kaydı: her kontrolün özetini lastRun + runHistory + totalStats'e yazar
async function recordRun(run) {
  const stored = await chrome.storage.local.get(['runHistory', 'totalStats']);
  const runHistory = stored.runHistory || [];
  const totalStats = stored.totalStats || { totalChecks: 0, totalChecked: 0, totalRetweeted: 0 };

  const entry = {
    timestamp: new Date().toISOString(),
    trigger: run.trigger || 'manual',
    username: run.username || '',
    mode: run.mode || 'none',
    success: Boolean(run.success),
    checkedCount: run.checkedCount || 0,
    eligibleCount: run.eligibleCount || 0,
    retweetedCount: (run.retweetedIds || []).length,
    retweetedIds: run.retweetedIds || [],
    failedIds: run.failedIds || [],
    failedCount: (run.failedIds || []).length,
    skippedAlready: run.skippedAlready || 0,
    skippedReply: run.skippedReply || 0,
    skippedRepost: run.skippedRepost || 0,
    skippedAd: run.skippedAd || 0,
    message: run.message || '',
    durationMs: run.durationMs || 0
  };

  runHistory.unshift(entry);
  if (runHistory.length > 20) runHistory.length = 20;

  totalStats.totalChecks += 1;
  totalStats.totalChecked += entry.checkedCount;
  totalStats.totalRetweeted += entry.retweetedCount;
  totalStats.lastCheck = entry.timestamp;
  if (entry.retweetedCount > 0) totalStats.lastSuccess = entry.timestamp;

  await chrome.storage.local.set({
    lastRun: entry,
    runHistory,
    totalStats,
    lastCheck: entry.timestamp,
    ...(entry.retweetedCount > 0 ? { lastSuccess: entry.timestamp } : {})
  });
  return entry;
}

async function checkAndRetweetLight(targetUsername, retweetHistory, tweetCount, retweetType) {
  // 1) Hafif okuma: Fx API (sekme yok, DOM yok)
  const items = await fetchTimelineViaFx(targetUsername, Math.max(tweetCount * 2, 5));
  console.log(`[hafif mod] Fx API'den ${items.length} tweet alındı`);

  const eligible = [];
  let skippedAlready = 0, skippedReply = 0, skippedRepost = 0;
  const targetLower = normalizeUsername(targetUsername);
  for (const item of items) {
    const rawId = item?.id ?? item?.tweetID;
    if (!rawId) continue;
    const itemId = String(rawId);
    // Zaten retweet edilmiş mi?
    if (retweetHistory.some(h => String(h.tweetId) === itemId)) {
      console.log(`[hafif mod] ${itemId} zaten geçmişte var, atlanıyor`);
      skippedAlready++;
      continue;
    }
    // Reply mi? (Fx: replying_to veya replying_to_status doluysa reply)
    // Not: quote tweet'lerde replying_to=null olur, orijinal sayılır (bilerek).
    if (item.replying_to || item.replying_to_status) {
      console.log(`[hafif mod] ${itemId} reply, atlanıyor`);
      skippedReply++;
      continue;
    }
    // Orijinal mi / repost mu? (Fx: reposted_by varsa hedef kullanıcının retweet'i)
    // author boşsa sadece reposted_by'ya güven (yanlış elemeyi önler).
    const authorLower = normalizeUsername(item.author?.screen_name || '');
    const hasRepostedBy = Boolean(item.reposted_by);
    const authorMismatch = Boolean(authorLower) && authorLower !== targetLower;
    const isRepost = hasRepostedBy || authorMismatch;
    if (retweetType === 'original' && isRepost) {
      console.log(`[hafif mod] ${itemId} repost, atlanıyor (orijinal modu)`);
      skippedRepost++;
      continue;
    }
    if (retweetType === 'retweets' && !isRepost) {
      console.log(`[hafif mod] ${itemId} orijinal, atlanıyor (retweet modu)`);
      skippedRepost++;
      continue;
    }
    eligible.push(itemId);
    if (eligible.length >= tweetCount) break;
  }

  const stats = {
    checkedCount: items.length,
    eligibleCount: eligible.length,
    skippedAlready,
    skippedReply,
    skippedRepost,
    skippedAd: 0 // hafif modda reklam dönmez
  };

  if (eligible.length === 0) {
    await chrome.storage.local.set({ lastCheck: new Date().toISOString() });
    return { success: false, message: `@${targetUsername} için retweet edilebilir yeni tweet yok (hafif mod, ${items.length} kontrol edildi).`, mode: 'light', retweetedIds: [], failedIds: [], ...stats };
  }

  // 2) Hafif yazma: GraphQL (tıklama yok, sekme yok)
  // Kısmi başarı desteklenir: biri patlarsa diğerleri devam eder, sebebi kaydedilir.
  const retweetedIds = [];
  const failedIds = [];
  for (const tweetId of eligible) {
    // Rate-limit dostu küçük gecikme
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    try {
      await retweetViaGraphQL(tweetId);
      console.log(`[hafif mod] retweet OK: ${tweetId}`);
      retweetedIds.push(tweetId);
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 160);
      console.warn(`[hafif mod] retweet BAŞARISIZ ${tweetId}: ${reason}`);
      failedIds.push({ tweetId, reason });
      // Duplicate/already-retweeted ise history'e ekle ki tekrar denenmesin
      if (/already|duplicate|326|already retweeted/i.test(reason)) {
        try { await saveRetweetsToHistory(targetUsername, [tweetId]); } catch (_) {}
      }
    }
  }

  if (retweetedIds.length > 0) {
    await saveRetweetsToHistory(targetUsername, retweetedIds);
  }
  const failNote = failedIds.length
    ? ` (${failedIds.length} başarısız: ${failedIds.map(f => f.tweetId).join(', ')})`
    : '';
  return {
    success: retweetedIds.length > 0,
    message: retweetedIds.length > 0
      ? `${retweetedIds.length} tweet retweet edildi (hafif mod, sekme açılmadı)!${failNote}`
      : `Hiç retweet gönderilemedi (hafif mod)${failNote}`,
    retweetedIds,
    failedIds,
    mode: 'light',
    ...stats
  };
}

async function checkAndRetweet(trigger = 'manual') {
  const startMs = Date.now();
  try {
    console.log('checkAndRetweet başladı (heavy mod)');

    const data = await chrome.storage.local.get(['targetUsername', 'retweetHistory', 'tweetCount', 'retweetType']);
    if (!data.targetUsername) {
      const fail = { success: false, message: 'Lütfen önce takip edilecek kullanıcı adını ayarlayın', mode: 'none', retweetedIds: [], checkedCount: 0, eligibleCount: 0, skippedAlready: 0, skippedReply: 0, skippedRepost: 0, skippedAd: 0 };
      const entry = await recordRun({ ...fail, trigger, username: '', durationMs: Date.now() - startMs });
      return { ...fail, stats: entry };
    }
    const retweetHistory = data.retweetHistory || [];
    const tweetCount = data.tweetCount || 1;
    const retweetType = data.retweetType || 'both';

  let lightFallbackInfo = null;
    if (USE_LIGHT_MODE) {
    try {
      const lightResult = await checkAndRetweetLight(data.targetUsername, retweetHistory, tweetCount, retweetType);
      console.log('Hafif mod sonucu:', lightResult);
      // Başarılı retweet varsa bitir. "Uygun yok" sonucu KESİN DEĞİL:
      // Fx şekli/thread/quote yüzünden yanlış eleme olabilir, heavy ile ikinci görüş al.
      if (lightResult.success && (lightResult.retweetedIds || []).length > 0) {
        const entry = await recordRun({ ...lightResult, trigger, username: data.targetUsername, durationMs: Date.now() - startMs });
        return { ...lightResult, stats: entry };
      }
      console.log(`Hafif modda uygun bulunamadı (${lightResult.checkedCount} incelendi), heavy ile doğrulanacak...`);
      // lightResult'ı sakla: heavy de bulamazsa sebebi açıklamak için kullanacağız
      lightFallbackInfo = lightResult;
    } catch (lightError) {
      console.warn('Hafif mod başarısız, klasik moda düşülüyor:', lightError.message);
      // Eğer cookie yoksa kullanıcıya net söyle ama yine de heavy dene
    }
    } else {
      console.log('Hafif mod kapalı (USE_LIGHT_MODE=false), direkt heavy çalışıyor...');
    }

    console.log('Klasik moda geçiliyor (heavy)...');
    const heavyResult = await checkAndRetweetHeavy(trigger, startMs);
    // Her iki mod da boşsa kullanıcıya birleşik bilgi ver (neden bulunamadığı anlaşılsın)
    if (!heavyResult.success && lightFallbackInfo) {
      heavyResult.message += ` [Hafif mod da ${lightFallbackInfo.checkedCount} tweet bakıp ${lightFallbackInfo.eligibleCount} uygun bulmuştu]`;
    }
    return heavyResult;
  } catch (error) {
    console.error('checkAndRetweet hatası:', error);
    const entry = await recordRun({ success: false, message: error.message, mode: 'none', trigger, username: '', durationMs: Date.now() - startMs });
    return { success: false, message: error.message, stats: entry };
  }
}

async function waitForPageComplete(tabId, timeoutMs = 15000) {
  await new Promise((resolve) => {
    let completed = false;
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete' && !completed) {
        completed = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!completed) {
        completed = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);
  });
}

async function countArticles(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.querySelectorAll('article[data-testid="tweet"]').length
    });
    return r[0]?.result || 0;
  } catch (e) {
    return 0;
  }
}

async function waitForArticles(tabId, tries = 10, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    const n = await countArticles(tabId);
    console.log(`Tweet kontrolü ${i + 1}/${tries}: ${n} tweet bulundu`);
    if (n > 0) {
      console.log('✓ Tweetler yüklendi!');
      return true;
    }
  }
  return false;
}

async function scrollLoadTweets(tabId, budget) {
  try {
    const needCount = Math.min(Math.max(budget * 3, 10), 30);
    for (let s = 0; s < 5; s++) {
      const n = await countArticles(tabId);
      console.log(`Scroll kontrol ${s + 1}/5: ${n}/${needCount} tweet`);
      if (n >= needCount) break;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.scrollBy(0, window.innerHeight * 2); }
      });
      await new Promise(r => setTimeout(r, 1500));
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.scrollTo(0, 0); }
    }).catch(() => {});
  } catch (e) {
    console.log('Scroll hatası (devam ediliyor):', e.message);
  }
  await new Promise(r => setTimeout(r, 1000));
}

// X Temmuz 2026 redesign: Posts ve Reposts ayrı sekmede. Reposts sekmesini
// önce sayfa içindeki sekmeye tıklayarak açmayı dene, olmazsa /reposts URL'ine git.
async function openRepostsTab(tabId, username, profileUrl) {
  try {
    const clickRes = await chrome.scripting.executeScript({
      target: { tabId },
      func: (uname) => {
        const u = String(uname || '').toLowerCase();
        const links = [...document.querySelectorAll('a[href]')];
        const hrefs = [...new Set(
          links.map(a => a.getAttribute('href')).filter(h => h && h.toLowerCase().includes('/' + u + '/'))
        )].slice(0, 20);
        let cand = links.find(a => String(a.getAttribute('href') || '').toLowerCase().includes('/reposts'));
        if (!cand) {
          const tabs = [...document.querySelectorAll('[role="tab"]')];
          cand = tabs.find(el => /repost/i.test(el.textContent || ''));
        }
        if (cand) { cand.click(); return { clicked: true }; }
        return { clicked: false, hrefs };
      },
      args: [username]
    });
    const cr = clickRes[0]?.result || {};
    if (cr.clicked) {
      console.log('Reposts sekmesine tıklandı');
      if (await waitForArticles(tabId, 6, 1500)) return { ok: true, via: 'click' };
      console.log('Tıklama sonrası tweet gelmedi, /reposts URL deneniyor...');
    } else {
      console.log('Reposts sekme linki bulunamadı, /reposts URL deneniyor...', (cr.hrefs || []).join(','));
    }
  } catch (e) {
    console.log('Reposts sekme tıklama hatası:', e.message);
  }
  try {
    await chrome.tabs.update(tabId, { url: `${profileUrl}/reposts` });
    await waitForPageComplete(tabId);
    if (await waitForArticles(tabId, 6, 1500)) return { ok: true, via: 'url' };
    return { ok: false, via: 'url', hint: 'Reposts sekmesi açılamadı (/reposts boş geldi). Sekme adını profilde elle kontrol edin.' };
  } catch (e) {
    return { ok: false, via: 'url', hint: 'Reposts sekmesi hatası: ' + e.message };
  }
}

async function processProfileTab(targetTab, profileUrl, username, tabKey, history, budget, retweetType) {
  const tabLabel = tabKey === 'reposts' ? 'Reposts' : 'Posts';
  console.log(`--- Sekme işleniyor: ${tabLabel} (bütçe: ${budget}) ---`);
  await chrome.tabs.update(targetTab.id, { url: profileUrl });
  await waitForPageComplete(targetTab.id);
  const loaded = await waitForArticles(targetTab.id);
  if (tabKey === 'reposts') {
    const opened = await openRepostsTab(targetTab.id, username, profileUrl);
    if (!opened.ok) {
      return { success: false, message: `@${username} (${tabLabel} sekmesi): ${opened.hint || 'açılamadı.'}`, retweetedIds: [], failedIds: [], tabKey, stats: { checkedCount: 0, eligibleCount: 0, skippedAlready: 0, skippedReply: 0, skippedRepost: 0, skippedAd: 0 } };
    }
  } else if (!loaded) {
    console.warn(`⚠ ${tabLabel} sekmesinde tweet yüklenemedi, yine de devam...`);
  }
  await scrollLoadTweets(targetTab.id, budget);
  console.log('Script çalıştırılıyor...');
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: findAndRetweetLatest,
    args: [username, history, budget, retweetType, tabKey]
  });
  const result = results[0].result;
  result.tabKey = tabKey;
  console.log(`${tabLabel} sonucu:`, result);
  return result;
}

async function checkAndRetweetHeavy(trigger = 'manual', startMs = Date.now()) {
  try {
    console.log('checkAndRetweet başladı');
    
    // Ayarları al
    const data = await chrome.storage.local.get(['targetUsername', 'retweetHistory', 'tweetCount', 'retweetType']);
    console.log('Ayarlar alındı:', { username: data.targetUsername, tweetCount: data.tweetCount, retweetType: data.retweetType });
    
    if (!data.targetUsername) {
      console.log('Kullanıcı adı ayarlanmamış');
      return { success: false, message: 'Lütfen önce takip edilecek kullanıcı adını ayarlayın' };
    }
    
    const retweetHistory = data.retweetHistory || [];
    const tweetCount = data.tweetCount || 1;
    const retweetType = data.retweetType || 'both';
    
    console.log(`Retweet geçmişinde ${retweetHistory.length} kayıt var`);
    
    // Twitter/X sekmesi bul
    const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'] });
    console.log(`${tabs.length} adet Twitter/X sekmesi bulundu`);
    
    let targetTab;
    const profileUrl = `https://x.com/${data.targetUsername}`;
    
    // Her zaman sayfayı yeniden yükle - daha güvenilir
    if (tabs.length > 0) {
      targetTab = tabs[0];
      console.log(`Mevcut sekme kullanılıyor: ${targetTab.id}`);
    } else {
      // Yeni sekme aç
      console.log('Yeni Twitter sekmesi açılıyor...');
      targetTab = await chrome.tabs.create({ 
        url: profileUrl,
        active: false 
      });
      console.log(`Yeni sekme oluşturuldu: ${targetTab.id}`);
    }
    
    // X Temmuz 2026 sonrası: Posts ve Reposts ayrı sekmede. Ayar tipine göre
    // gezilecek sekmeler belirlenir, tweet bütçesi sekmeler arası paylaşılır.
    const jobs = retweetType === 'original' ? ['posts']
      : retweetType === 'retweets' ? ['reposts']
      : ['posts', 'reposts'];
    console.log(`Gezilecek sekmeler: ${jobs.join(', ')} (tip: ${retweetType})`);
    const tabName = (k) => k === 'reposts' ? 'Reposts' : 'Posts';

    const merged = {
      retweetedIds: [], failedIds: [],
      checkedCount: 0, eligibleCount: 0,
      skippedAlready: 0, skippedReply: 0, skippedRepost: 0, skippedAd: 0,
      messages: []
    };

    for (const tabKey of jobs) {
      const remaining = tweetCount - merged.retweetedIds.length;
      if (remaining <= 0) break;
      const runHistory = retweetHistory.concat(merged.retweetedIds.map(id => ({ tweetId: id })));
      let r;
      try {
        r = await processProfileTab(targetTab, profileUrl, data.targetUsername, tabKey, runHistory, remaining, retweetType);
      } catch (e) {
        console.warn(`${tabKey} sekme hatası:`, e.message);
        r = { success: false, message: `hata: ${e.message}`, retweetedIds: [], failedIds: [], stats: { checkedCount: 0, eligibleCount: 0, skippedAlready: 0, skippedReply: 0, skippedRepost: 0, skippedAd: 0 } };
      }
      const st = r.stats || {};
      merged.checkedCount += st.checkedCount || 0;
      merged.eligibleCount += st.eligibleCount ?? (r.retweetedIds || []).length;
      merged.skippedAlready += st.skippedAlready || 0;
      merged.skippedReply += st.skippedReply || 0;
      merged.skippedRepost += st.skippedRepost || 0;
      merged.skippedAd += st.skippedAd || 0;
      merged.retweetedIds.push(...(r.retweetedIds || []));
      for (const f of (r.failedIds || [])) {
        merged.failedIds.push(typeof f === 'string'
          ? { tweetId: f, reason: `[${tabName(tabKey)}]` }
          : { tweetId: f.tweetId, reason: (`[${tabName(tabKey)}] ${f.reason || ''}`).trim() });
      }
      if (r.message) merged.messages.push(`[${tabName(tabKey)}] ${r.message}`);
    }

    const result = {
      success: merged.retweetedIds.length > 0,
      message: merged.messages.join(' | ') || 'Sekmelerden sonuç alınamadı',
      retweetedIds: merged.retweetedIds,
      failedIds: merged.failedIds,
      stats: {
        checkedCount: merged.checkedCount,
        eligibleCount: merged.eligibleCount,
        skippedAlready: merged.skippedAlready,
        skippedReply: merged.skippedReply,
        skippedRepost: merged.skippedRepost,
        skippedAd: merged.skippedAd
      }
    };
    console.log('Birleşik sonuç:', result);
    const pageStats = result.stats || {};
    const baseStats = {
      username: data.targetUsername,
      trigger,
      mode: 'heavy',
      checkedCount: pageStats.checkedCount || 0,
      eligibleCount: pageStats.eligibleCount ?? (result.retweetedIds || []).length,
      retweetedIds: result.retweetedIds || [],
      failedIds: result.failedIds || [],
      skippedAlready: pageStats.skippedAlready || 0,
      skippedReply: pageStats.skippedReply || 0,
      skippedRepost: pageStats.skippedRepost || 0,
      skippedAd: pageStats.skippedAd || 0,
      durationMs: Date.now() - startMs
    };
    
    if (result.success && result.retweetedIds && result.retweetedIds.length > 0) {
      console.log(`${result.retweetedIds.length} tweet retweet edildi`);
      
      // Retweet geçmişine ekle
      result.retweetedIds.forEach(tweetId => {
        retweetHistory.push({
          tweetId: tweetId,
          username: data.targetUsername,
          timestamp: new Date().toISOString()
        });
      });
      
      // Son 200 retweet'i sakla
      if (retweetHistory.length > 200) {
        retweetHistory.splice(0, retweetHistory.length - 200);
      }
      
      await chrome.storage.local.set({
        retweetHistory: retweetHistory,
        lastCheck: new Date().toISOString(),
        lastSuccess: new Date().toISOString()
      });
      
      console.log('Geçmiş kaydedildi');
      const entry = await recordRun({ ...baseStats, success: true, message: result.message });
      return { ...result, mode: 'heavy', ...baseStats, success: true, stats: entry };
    } else {
      console.log('Retweet edilecek yeni tweet bulunamadı');
      
      await chrome.storage.local.set({
        lastCheck: new Date().toISOString()
      });
      const entry = await recordRun({ ...baseStats, success: false, message: result.message });
      return { ...result, mode: 'heavy', ...baseStats, success: false, stats: entry };
    }
    
  } catch (error) {
    console.error('checkAndRetweet hatası:', error);
    console.error('Hata detayı:', error.stack);
    const entry = await recordRun({ success: false, message: error.message, mode: 'heavy', trigger, username: '', durationMs: Date.now() - startMs });
    return { success: false, message: error.message, stats: entry };
  }
}

// Sayfa içinde çalışacak fonksiyon
function findAndRetweetLatest(targetUsername, retweetHistory, tweetCount, retweetType = 'both', tabKey = 'posts') {
  return new Promise((resolve) => {
    try {
      const norm = (u) => String(u || '').trim().replace(/@/g, '').toLowerCase();
      const targetLower = norm(targetUsername);
      const extractId = (url) => {
        if (!url) return null;
        const m = String(url).match(/\/status\/(\d+)/);
        return m ? m[1] : null;
      };
      // Önce doğru sayfada olup olmadığını kontrol et
      const currentUrl = window.location.href;

      if (!currentUrl.toLowerCase().includes(targetLower)) {
        // Kullanıcı profiline git
        window.location.href = `https://x.com/${targetUsername}`;
        setTimeout(() => {
          resolve({ success: false, message: 'Profil sayfasına yönlendiriliyor...' });
        }, 1000);
        return;
      }
      
      // Tweet'leri bul
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      
      if (articles.length === 0) {
        resolve({ success: false, message: 'Tweet bulunamadı. Sayfa yükleniyor olabilir.', stats: { checkedCount: 0, eligibleCount: 0, skippedAlready: 0, skippedReply: 0, skippedRepost: 0, skippedAd: 0 } });
        return;
      }
      
      console.log(`Toplam ${articles.length} tweet bulundu`);
      
      // Uygun tweetleri bul
      const eligibleTweets = [];
      let skippedAd = 0, skippedAlready = 0, skippedReply = 0, skippedRepost = 0;
      
      for (const article of articles) {
        // Ana tweet linkini bul: zaman damgalı linki tercih et (quote içindeki
        // gömülü linki değil, tweetin kendi linkini almak için).
        const allLinks = article.querySelectorAll('a[href*="/status/"]');
        if (!allLinks || allLinks.length === 0) {
          console.log('Tweet linki bulunamadı, atlanıyor');
          continue;
        }
        let tweetLink = allLinks[0];
        for (const a of allLinks) {
          if (a.querySelector('time')) { tweetLink = a; break; }
        }

        const href = tweetLink.href;

        // Tweet ID'sini al (/photo/1, ?s=xx gibi ekleri regex ile temizle)
        const currentTweetId = extractId(href);
        if (!currentTweetId) {
          console.log('Tweet ID alınamadı, atlanıyor');
          continue;
        }

        // Linkteki kullanıcı adı: repost'ta orijinal yazara işaret eder
        let usernameFromLink = '';
        try { usernameFromLink = norm(href.split('/')[3] || ''); } catch (e) { usernameFromLink = ''; }

        
        // Promoted/Reklam tweet kontrolü - sadece güvenilir göstergelere bak
        // NOT: 'Ad', 'finans', 'bahis' gibi genel kelimeler bilinçli olarak kontrol edilmiyor
        // (normal tweet'lerde geçebileceği için yanlış eleme yapıyordu)
        const promotedIndicator = article.querySelector('[data-testid="promotedIndicator"]');
        const promotedSvg = article.querySelector('svg[aria-label="Promoted"], svg[aria-label="Sponsored"], svg[aria-label="Sponsorlu"], svg[aria-label="Reklam"]');
        let hasPromotedLabel = false;
        // Sadece tek kelimelik "Ad" / "Promoted" / "Sponsored" etiketlerini ara, substring değil
        const spans = article.querySelectorAll('span');
        for (const span of spans) {
          const t = span.textContent.trim();
          if (t === 'Ad' || t === 'Promoted' || t === 'Sponsored' || t === 'Sponsorlu' || t === 'Reklam') {
            hasPromotedLabel = true;
            break;
          }
        }
        const isPromoted = promotedIndicator !== null || promotedSvg !== null || hasPromotedLabel;
        
        if (isPromoted) {
          console.log(`Tweet ${currentTweetId} bir reklam (promoted), atlanıyor`);
          skippedAd++;
          continue;
        }
        
        // Bu tweet daha önce retweet edilmiş mi kontrol et
        const alreadyRetweeted = (retweetHistory || []).some(item => String(item.tweetId) === currentTweetId);
        if (alreadyRetweeted) {
          console.log(`Tweet ${currentTweetId} zaten retweet edilmiş, atlanıyor`);
          skippedAlready++;
          continue;
        }

        // Reply mi kontrol et (Türkçe + İngilizce, büyük/küçük harf duyarsız)
        // article.textContent tüm kartı kapsar; olası varyasyonları geniş tuttuk.
        const articleTextLower = article.textContent.toLowerCase();
        const isReply = articleTextLower.includes('replying to') ||
                       articleTextLower.includes('yanıt olarak') ||
                       articleTextLower.includes('yanit olarak') ||
                       articleTextLower.includes('yanıtlanan') ||
                       articleTextLower.includes('kime yanıt');
        
        if (isReply) {
          console.log(`Tweet ${currentTweetId} bir reply, atlanıyor`);
          skippedReply++;
          continue;
        }

        // Orijinal tweet mi, yoksa hedef kullanıcının retweet'i mi?
        // Birincil sinyal: linkteki kullanıcı adı (en güvenilir).
        // Yedek sinyal: socialContext yazısı (DOM değişirse diye).
        const socialContextEl = article.querySelector('[data-testid="socialContext"]');
        const socialText = socialContextEl ? socialContextEl.textContent.toLowerCase() : '';
        const socialSaysRepost = socialText.includes('repost') ||
                               socialText.includes('reposted') ||
                               socialText.includes('retweet') ||
                               socialText.includes('yeniden gönder') ||
                               socialText.includes('tekrar paylaştı') ||
                               socialText.includes('yeniden yayın');
        const linkSaysRepost = Boolean(usernameFromLink) && usernameFromLink !== targetLower;
        // socialContext yoksa linke güven; varsa ikisinden biri yetiyor.
        // Hiç sinyal yoksa (boş kart) orijinal kabul et - yanlış elemeyi önler.
        const isRepostByUser = linkSaysRepost || socialSaysRepost;

        if (retweetType === 'original' && isRepostByUser) {
          console.log(`Tweet ${currentTweetId} hedef kullanıcının retweet'i, atlanıyor (sadece orijinal modu)`);
          skippedRepost++;
          continue;
        }

        if (retweetType === 'retweets' && !isRepostByUser) {
          console.log(`Tweet ${currentTweetId} orijinal tweet, atlanıyor (sadece retweet modu)`);
          skippedRepost++;
          continue;
        }
        
        // Reply değilse ve hedef kullanıcının tweeti ise ekle
        eligibleTweets.push({
          element: article,
          tweetId: currentTweetId
        });
        console.log(`Uygun tweet bulundu: ${currentTweetId}`);
        
        // Yeterli tweet bulunduysa dur
        if (eligibleTweets.length >= tweetCount) {
          break;
        }
      }
      
      console.log(`Toplam ${eligibleTweets.length} uygun tweet bulundu`);
      
      if (eligibleTweets.length === 0) {
        const tabNote = tabKey === 'reposts' ? 'Reposts sekmesinde ' : 'Posts sekmesinde ';
        resolve({
          success: false,
          message: `@${targetUsername} için retweet edilebilir tweet bulunamadı. ${tabNote}${articles.length} tweet kontrol edildi (atlanan: kayıt ${skippedAlready}, reply ${skippedReply}, repost ${skippedRepost}, reklam ${skippedAd}).`,
          stats: { checkedCount: articles.length, eligibleCount: 0, skippedAlready, skippedReply, skippedRepost, skippedAd }
        });
        return;
      }
      
      // Tweetleri sırayla retweet et (kısmi başarı raporlanır)
      let retweetedCount = 0;
      const retweetedIds = [];
      const failedIds = [];

      function retweetNext(index) {
        if (index >= eligibleTweets.length) {
          // Tüm tweetler işlendi
          const failNote = failedIds.length
            ? ` (${failedIds.length} başarısız: ${failedIds.map(f => f.tweetId).join(', ')})`
            : '';
          const ok = retweetedIds.length > 0;
          resolve({
            success: ok,
            message: ok
              ? `${retweetedCount} tweet başarıyla retweet edildi!${failNote}`
              : `Hiç retweet gönderilemedi.${failNote}`,
            retweetedIds: retweetedIds,
            failedIds: failedIds,
            stats: { checkedCount: articles.length, eligibleCount: eligibleTweets.length, skippedAlready, skippedReply, skippedRepost, skippedAd }
          });
          return;
        }

        const tweet = eligibleTweets[index];
        // Buton bulucu: X testid'leri dönem dönem değiştiriyor (retweet->repost).
        // Sırayla dene: testid varyantları, sonra aria-label ile buton tara.
        const findRetweetButton = (root) => {
          const sels = [
            '[data-testid="retweet"]',
            '[data-testid="repost"]',
            '[data-testid="retweetButton"]',
            '[data-testid="repostButton"]'
          ];
          for (const s of sels) {
            const el = root.querySelector(s);
            if (el) return el;
          }
          const btns = root.querySelectorAll('button[aria-label], div[role="button"][aria-label]');
          for (const b of btns) {
            const l = (b.getAttribute('aria-label') || '').toLowerCase();
            if (l.includes('repost') || l.includes('retweet') || l.includes('yeniden gönder') || l.includes('tekrar paylaş')) return b;
          }
          return null;
        };
        // Zaten retweetlenmiş mi? (yeşil buton = aria-pressed true / label'da Undo)
        const retweetButton = findRetweetButton(tweet.element);

        if (!retweetButton) {
          // Teşhis için karttaki testid'leri sebebe ekle (popup'ta görünsün)
          let tidNote = 'kartta testid yok';
          try {
            const tids = [];
            tweet.element.querySelectorAll('[data-testid]').forEach(el => {
              const t = el.getAttribute('data-testid');
              if (t && !tids.includes(t)) tids.push(t);
            });
            if (tids.length) tidNote = 'kart: ' + tids.slice(0, 12).join(',');
          } catch (e) {}
          console.log(`Tweet ${tweet.tweetId} için retweet butonu bulunamadı (${tidNote})`);
          failedIds.push({ tweetId: tweet.tweetId, reason: 'buton yok [' + tidNote + ']' });
          // Bu tweet için retweet butonu bulunamadı, bir sonrakine geç
          setTimeout(() => retweetNext(index + 1), 500);
          return;
        }

        // İnsan benzeri gecikme ile retweet et
        setTimeout(() => {
          // Tıklamadan önce "zaten retweetli" sinyalini yakala
          const pressed = retweetButton.getAttribute('aria-pressed') === 'true';
          const btnLabel = (retweetButton.getAttribute('aria-label') || '').toLowerCase();
          if (pressed || btnLabel.includes('undo') || btnLabel.includes('geri al')) {
            console.log(`Tweet ${tweet.tweetId} zaten retweetlenmiş görünüyor, atlanıyor`);
            failedIds.push({ tweetId: tweet.tweetId, reason: 'X tarafında zaten retweetli' });
            setTimeout(() => retweetNext(index + 1), 500);
            return;
          }
          retweetButton.click();
          console.log(`Retweet butonu tıklandı: ${tweet.tweetId}`);

          // Retweet onay menüsünü bekle ve tıkla (testid varyantları)
          setTimeout(() => {
            const confirmButton = document.querySelector('[data-testid="retweetConfirm"]')
              || document.querySelector('[data-testid="repostConfirm"]')
              || document.querySelector('[data-testid="retweetConfirmButton"]');
            // Zaten retweetliyse menüde "Undo repost" çıkar, confirm olmaz
            const undoButton = document.querySelector('[data-testid="unretweetConfirm"]')
              || document.querySelector('[data-testid="unrepostConfirm"]');

            if (confirmButton) {
              confirmButton.click();
              retweetedCount++;
              retweetedIds.push(tweet.tweetId);
              console.log(`Tweet retweet edildi: ${tweet.tweetId}`);

              // Bir sonraki tweet için gecikme (Twitter rate limiting'den kaçınmak için)
              setTimeout(() => retweetNext(index + 1), 1500 + Math.random() * 1000);
            } else {
              // Açık menüyü kapatmaya çalış (ESC)
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
              const reason = undoButton
                ? 'X tarafında zaten retweetli (Undo menüsü)'
                : 'onay butonu yok (rate-limit/oturum olabilir)';
              console.log(`Retweet onay butonu bulunamadı: ${tweet.tweetId} - ${reason}`);
              failedIds.push({ tweetId: tweet.tweetId, reason });
              // Onay butonu bulunamadı, bir sonrakine geç
              setTimeout(() => retweetNext(index + 1), 500);
            }
          }, 500 + Math.random() * 500);

        }, 300 + Math.random() * 700);
      }
      
      // İlk tweet'ten başla
      retweetNext(0);
      
    } catch (error) {
      console.error('Hata oluştu:', error);
      resolve({ success: false, message: 'Hata: ' + error.message });
    }
  });
}
