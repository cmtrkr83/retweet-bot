// Background Service Worker
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
    const retweetType = request.retweetType || 'original';
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
    return { success: false, message: `@${targetUsername} için retweet edilebilir yeni tweet yok (hafif mod, ${items.length} kontrol edildi).`, mode: 'light', retweetedIds: [], ...stats };
  }

  // 2) Hafif yazma: GraphQL (tıklama yok, sekme yok)
  const retweetedIds = [];
  for (const tweetId of eligible) {
    // Rate-limit dostu küçük gecikme
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    await retweetViaGraphQL(tweetId);
    console.log(`[hafif mod] retweet OK: ${tweetId}`);
    retweetedIds.push(tweetId);
  }

  await saveRetweetsToHistory(targetUsername, retweetedIds);
  return {
    success: true,
    message: `${retweetedIds.length} tweet retweet edildi (hafif mod, sekme açılmadı)!`,
    retweetedIds,
    mode: 'light',
    ...stats
  };
}

async function checkAndRetweet(trigger = 'manual') {
  const startMs = Date.now();
  try {
    console.log('checkAndRetweet başladı (önce hafif mod denenecek)');

    const data = await chrome.storage.local.get(['targetUsername', 'retweetHistory', 'tweetCount', 'retweetType']);
    if (!data.targetUsername) {
      const fail = { success: false, message: 'Lütfen önce takip edilecek kullanıcı adını ayarlayın', mode: 'none', retweetedIds: [], checkedCount: 0, eligibleCount: 0, skippedAlready: 0, skippedReply: 0, skippedRepost: 0, skippedAd: 0 };
      const entry = await recordRun({ ...fail, trigger, username: '', durationMs: Date.now() - startMs });
      return { ...fail, stats: entry };
    }
    const retweetHistory = data.retweetHistory || [];
    const tweetCount = data.tweetCount || 1;
    const retweetType = data.retweetType || 'original';

    let lightFallbackInfo = null;
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
    const retweetType = data.retweetType || 'original';
    
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
    
    // Sayfayı yenile/yükle
    console.log(`Sayfa yükleniyor: ${profileUrl}`);
    await chrome.tabs.update(targetTab.id, { url: profileUrl });
    
    // Sayfanın tam yüklenmesini güvenilir şekilde bekle
    await new Promise((resolve) => {
      let completed = false;
      
      const listener = (tabId, changeInfo) => {
        if (tabId === targetTab.id && changeInfo.status === 'complete' && !completed) {
          completed = true;
          chrome.tabs.onUpdated.removeListener(listener);
          console.log('Sayfa yüklendi (complete event)');
          resolve();
        }
      };

      
      chrome.tabs.onUpdated.addListener(listener);
      
      // Timeout - 15 saniye (MV3 service worker ömrü için kısa tutuldu)
      setTimeout(() => {
        if (!completed) {
          completed = true;
          chrome.tabs.onUpdated.removeListener(listener);
          console.log('Sayfa yükleme timeout (15 saniye)');
          resolve();
        }
      }, 15000);
    });
    
    // Twitter'ın içeriğini yüklemesini bekle - tweet'lerin DOM'a gelmesini kontrol et
    console.log('Tweet\'lerin yüklenmesi kontrol ediliyor...');
    let tweetsLoaded = false;
    
    for (let i = 0; i < 10; i++) {
      // Her 1.5 saniyede bir kontrol et (MV3 worker ömrü için toplam ~15sn)
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      try {
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: () => {
            const articles = document.querySelectorAll('article[data-testid="tweet"]');
            return articles.length;
          }
        });
        
        const tweetCountInPage = checkResults[0].result;
        console.log(`Tweet kontrolü ${i + 1}/10: ${tweetCountInPage} tweet bulundu`);
        
        if (tweetCountInPage > 0) {
          tweetsLoaded = true;
          console.log('✓ Tweetler yüklendi!');
          break;
        }
      } catch (e) {
        console.log(`Tweet kontrol hatası (deneme ${i + 1}):`, e.message);
      }
    }
    
    if (!tweetsLoaded) {
      console.warn('⚠ Tweet yüklenemedi, yine de devam ediliyor...');
    }

    // Yeterli tweet yüklenene kadar aşağı kaydır (reply/reklam elemesi sonrası
    // ilk ekrandaki 5-7 tweet yetmeyebilir). Ücretli API yok, sadece DOM scroll.
    try {
      const needCount = Math.min(Math.max(tweetCount * 3, 10), 30);
      for (let s = 0; s < 5; s++) {
        const countRes = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: () => document.querySelectorAll('article[data-testid="tweet"]').length
        });
        const currentCount = countRes[0]?.result || 0;
        console.log(`Scroll kontrol ${s + 1}/5: ${currentCount}/${needCount} tweet`);
        if (currentCount >= needCount) break;
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: () => { window.scrollBy(0, window.innerHeight * 2); }
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      // En üste dön ki retweet butonları görünür olsun
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: () => { window.scrollTo(0, 0); }
      }).catch(() => {});
    } catch (e) {
      console.log('Scroll hatası (devam ediliyor):', e.message);
    }
    
    // Son güvenlik beklemesi
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('Script çalıştırılıyor...');
    
    // Content script'i çalıştır
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: findAndRetweetLatest,
      args: [data.targetUsername, retweetHistory, tweetCount, retweetType]
    });
    
    console.log('Script çalıştırıldı, sonuç alındı');
    
    const result = results[0].result;
    console.log('Sonuç:', result);
    const pageStats = result.stats || {};
    const baseStats = {
      username: data.targetUsername,
      trigger,
      mode: 'heavy',
      checkedCount: pageStats.checkedCount || 0,
      eligibleCount: pageStats.eligibleCount ?? (result.retweetedIds || []).length,
      retweetedIds: result.retweetedIds || [],
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
function findAndRetweetLatest(targetUsername, retweetHistory, tweetCount, retweetType = 'original') {
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
        resolve({ 
          success: false, 
          message: `@${targetUsername} için retweet edilebilir tweet bulunamadı. Toplam ${articles.length} tweet kontrol edildi.`,
          stats: { checkedCount: articles.length, eligibleCount: 0, skippedAlready, skippedReply, skippedRepost, skippedAd }
        });
        return;
      }
      
      // Tweetleri sırayla retweet et
      let retweetedCount = 0;
      const retweetedIds = [];
      
      function retweetNext(index) {
        if (index >= eligibleTweets.length) {
          // Tüm tweetler işlendi
          const message = `${retweetedCount} tweet başarıyla retweet edildi!`;
          resolve({
            success: true,
            message: message,
            retweetedIds: retweetedIds,
            stats: { checkedCount: articles.length, eligibleCount: eligibleTweets.length, skippedAlready, skippedReply, skippedRepost, skippedAd }
          });
          return;
        }
        
        const tweet = eligibleTweets[index];
        const retweetButton = tweet.element.querySelector('[data-testid="retweet"]');
        
        if (!retweetButton) {
          console.log(`Tweet ${tweet.tweetId} için retweet butonu bulunamadı`);
          // Bu tweet için retweet butonu bulunamadı, bir sonrakine geç
          setTimeout(() => retweetNext(index + 1), 500);
          return;
        }
        
        // İnsan benzeri gecikme ile retweet et
        setTimeout(() => {
          retweetButton.click();
          console.log(`Retweet butonu tıklandı: ${tweet.tweetId}`);
          
          // Retweet onay menüsünü bekle ve tıkla
          setTimeout(() => {
            const confirmButton = document.querySelector('[data-testid="retweetConfirm"]');
            
            if (confirmButton) {
              confirmButton.click();
              retweetedCount++;
              retweetedIds.push(tweet.tweetId);
              console.log(`Tweet retweet edildi: ${tweet.tweetId}`);
              
              // Bir sonraki tweet için gecikme (Twitter rate limiting'den kaçınmak için)
              setTimeout(() => retweetNext(index + 1), 1500 + Math.random() * 1000);
            } else {
              console.log('Retweet onay butonu bulunamadı');
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
