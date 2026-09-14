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
      const result = await checkAndRetweet();
      console.log('Otomatik kontrol tamamlandı:', result);
    } catch (error) {
      console.error('Otomatik kontrol hatası:', error);
    }
  }
});

// Manuel kontrol için mesaj dinleyici
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'manualCheck') {
    checkAndRetweet().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, message: 'Hata: ' + error.message });
    });
    return true; // Asenkron yanıt için
  }
  
  if (request.action === 'getStats') {
    chrome.storage.local.get(['retweetHistory', 'targetUsername', 'lastCheck', 'lastSuccess', 'tweetCount', 'retweetType'], (data) => {
      sendResponse(data);
    });
    return true;
  }
  
  if (request.action === 'saveSettings') {
    const checkInterval = request.checkInterval || 60;
    const retweetType = request.retweetType || 'original';
    
    chrome.storage.local.set({
      targetUsername: request.username,
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

async function fetchTimelineViaFx(username, count = 10) {
  const url = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(username)}/statuses?count=${Math.min(Math.max(count, 1), 20)}`;
  const res = await fetch(url, { method: 'GET' });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`Fx API hata: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 200) throw new Error(`Fx API hata: ${data.code} ${data.message || ''}`);
  return data.results || [];
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

async function checkAndRetweetLight(targetUsername, retweetHistory, tweetCount, retweetType) {
  // 1) Hafif okuma: Fx API (sekme yok, DOM yok)
  const items = await fetchTimelineViaFx(targetUsername, Math.max(tweetCount * 2, 5));
  console.log(`[hafif mod] Fx API'den ${items.length} tweet alındı`);

  const eligible = [];
  const targetLower = targetUsername.toLowerCase().replace('@', '');
  for (const item of items) {
    if (!item?.id) continue;
    // Zaten retweet edilmiş mi?
    if (retweetHistory.some(h => h.tweetId === String(item.id))) {
      console.log(`[hafif mod] ${item.id} zaten geçmişte var, atlanıyor`);
      continue;
    }
    // Reply mi? (Fx: replying_to doluysa reply)
    if (item.replying_to) {
      console.log(`[hafif mod] ${item.id} reply, atlanıyor`);
      continue;
    }
    // Orijinal mi / repost mu? (Fx: reposted_by varsa hedef kullanıcının retweet'i)
    const authorLower = (item.author?.screen_name || '').toLowerCase();
    const isRepost = Boolean(item.reposted_by) || (authorLower && authorLower !== targetLower);
    if (retweetType === 'original' && isRepost) {
      console.log(`[hafif mod] ${item.id} repost, atlanıyor (orijinal modu)`);
      continue;
    }
    if (retweetType === 'retweets' && !isRepost) {
      console.log(`[hafif mod] ${item.id} orijinal, atlanıyor (retweet modu)`);
      continue;
    }
    eligible.push(String(item.id));
    if (eligible.length >= tweetCount) break;
  }

  if (eligible.length === 0) {
    await chrome.storage.local.set({ lastCheck: new Date().toISOString() });
    return { success: false, message: `@${targetUsername} için retweet edilebilir yeni tweet yok (hafif mod, ${items.length} kontrol edildi).`, mode: 'light' };
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
    mode: 'light'
  };
}

async function checkAndRetweet() {
  try {
    console.log('checkAndRetweet başladı (önce hafif mod denenecek)');

    const data = await chrome.storage.local.get(['targetUsername', 'retweetHistory', 'tweetCount', 'retweetType']);
    if (!data.targetUsername) {
      return { success: false, message: 'Lütfen önce takip edilecek kullanıcı adını ayarlayın' };
    }
    const retweetHistory = data.retweetHistory || [];
    const tweetCount = data.tweetCount || 1;
    const retweetType = data.retweetType || 'original';

    try {
      const lightResult = await checkAndRetweetLight(data.targetUsername, retweetHistory, tweetCount, retweetType);
      console.log('Hafif mod sonucu:', lightResult);
      // Hafif modda "yeni tweet yok" da geçerli sonuçtur, heavy'e düşme
      if (lightResult.success || !lightResult.fallbackToHeavy) {
        // Yeni tweet yoksa da lightResult dön (fallback gereksiz)
        if (lightResult.success || lightResult.mode === 'light') return lightResult;
      }
    } catch (lightError) {
      console.warn('Hafif mod başarısız, klasik moda düşülüyor:', lightError.message);
      // Eğer cookie yoksa kullanıcıya net söyle ama yine de heavy dene
    }

    console.log('Klasik moda geçiliyor (heavy)...');
    return await checkAndRetweetHeavy();
  } catch (error) {
    console.error('checkAndRetweet hatası:', error);
    return { success: false, message: error.message };
  }
}

async function checkAndRetweetHeavy() {
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
    } else {
      console.log('Retweet edilecek yeni tweet bulunamadı');
      
      await chrome.storage.local.set({
        lastCheck: new Date().toISOString()
      });
    }
    
    return result;
    
  } catch (error) {
    console.error('checkAndRetweet hatası:', error);
    console.error('Hata detayı:', error.stack);
    return { success: false, message: error.message };
  }
}

// Sayfa içinde çalışacak fonksiyon
function findAndRetweetLatest(targetUsername, retweetHistory, tweetCount, retweetType = 'original') {
  return new Promise((resolve) => {
    try {
      // Önce doğru sayfada olup olmadığını kontrol et
      const currentUrl = window.location.href;
      
      if (!currentUrl.includes(targetUsername)) {
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
        resolve({ success: false, message: 'Tweet bulunamadı. Sayfa yükleniyor olabilir.' });
        return;
      }
      
      console.log(`Toplam ${articles.length} tweet bulundu`);
      
      // Uygun tweetleri bul
      const eligibleTweets = [];
      
      for (const article of articles) {
        // Tweet linkini bul
        const tweetLink = article.querySelector('a[href*="/status/"]');
        if (!tweetLink) {
          console.log('Tweet linki bulunamadı, atlanıyor');
          continue;
        }
        
        const href = tweetLink.href;
        
        // Tweet ID'sini al
        const currentTweetId = href.split('/status/')[1]?.split('?')[0];
        if (!currentTweetId) {
          console.log('Tweet ID alınamadı, atlanıyor');
          continue;
        }

        
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
          continue;
        }
        
        // Bu tweet daha önce retweet edilmiş mi kontrol et
        const alreadyRetweeted = retweetHistory.some(item => item.tweetId === currentTweetId);
        if (alreadyRetweeted) {
          console.log(`Tweet ${currentTweetId} zaten retweet edilmiş, atlanıyor`);
          continue;
        }
        
        // Reply mi kontrol et (Türkçe + İngilizce, büyük/küçük harf duyarsız)
        const articleTextLower = article.textContent.toLowerCase();
        const isReply = articleTextLower.includes('replying to') ||
                       articleTextLower.includes('yanıt olarak') ||
                       articleTextLower.includes('yanit olarak');
        
        if (isReply) {
          console.log(`Tweet ${currentTweetId} bir reply, atlanıyor`);
          continue;
        }

        // Orijinal tweet mi, yoksa hedef kullanıcının retweet'i mi? (socialContext)
        const socialContextEl = article.querySelector('[data-testid="socialContext"]');
        const socialText = socialContextEl ? socialContextEl.textContent.toLowerCase() : '';
        const isRepostByUser = socialText.includes('repost') ||
                               socialText.includes('reposted') ||
                               socialText.includes('retweet') ||
                               socialText.includes('yeniden gönder') ||
                               socialText.includes('tekrar paylaştı');

        if (retweetType === 'original' && isRepostByUser) {
          console.log(`Tweet ${currentTweetId} hedef kullanıcının retweet'i, atlanıyor (sadece orijinal modu)`);
          continue;
        }

        if (retweetType === 'retweets' && !isRepostByUser) {
          console.log(`Tweet ${currentTweetId} orijinal tweet, atlanıyor (sadece retweet modu)`);
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
          message: `@${targetUsername} için retweet edilebilir tweet bulunamadı. Toplam ${articles.length} tweet kontrol edildi.` 
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
            retweetedIds: retweetedIds
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
