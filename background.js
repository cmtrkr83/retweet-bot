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
    chrome.storage.local.get(['retweetHistory', 'targetUsername', 'lastCheck', 'tweetCount'], (data) => {
      sendResponse(data);
    });
    return true;
  }
  
  if (request.action === 'saveSettings') {
    const checkInterval = request.checkInterval || 60;
    
    chrome.storage.local.set({
      targetUsername: request.username,
      tweetCount: request.tweetCount || 1,
      checkInterval: checkInterval
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

async function checkAndRetweet() {
  try {
    console.log('checkAndRetweet başladı');
    
    // Ayarları al
    const data = await chrome.storage.local.get(['targetUsername', 'retweetHistory', 'tweetCount']);
    console.log('Ayarlar alındı:', { username: data.targetUsername, tweetCount: data.tweetCount });
    
    if (!data.targetUsername) {
      console.log('Kullanıcı adı ayarlanmamış');
      return { success: false, message: 'Lütfen önce takip edilecek kullanıcı adını ayarlayın' };
    }
    
    const retweetHistory = data.retweetHistory || [];
    const tweetCount = data.tweetCount || 1;
    
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
      
      // Timeout - 20 saniye
      setTimeout(() => {
        if (!completed) {
          completed = true;
          chrome.tabs.onUpdated.removeListener(listener);
          console.log('Sayfa yükleme timeout (20 saniye)');
          resolve();
        }
      }, 20000);
    });
    
    // Twitter'ın içeriğini yüklemesini bekle - tweet'lerin DOM'a gelmesini kontrol et
    console.log('Tweet\'lerin yüklenmesi kontrol ediliyor...');
    let tweetsLoaded = false;
    
    for (let i = 0; i < 10; i++) {
      // Her 1 saniyede bir kontrol et
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: () => {
            const articles = document.querySelectorAll('article[data-testid="tweet"]');
            return articles.length;
          }
        });
        
        const tweetCount = checkResults[0].result;
        console.log(`Tweet kontrolü ${i + 1}/10: ${tweetCount} tweet bulundu`);
        
        if (tweetCount > 0) {
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
      args: [data.targetUsername, retweetHistory, tweetCount]
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
      if (retweetHistory.length > 50) {
        retweetHistory.splice(0, retweetHistory.length - 50);
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
function findAndRetweetLatest(targetUsername, retweetHistory, tweetCount) {
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

        
        // Promoted/Reklam tweet kontrolü - birden fazla yöntemle
        const isPromoted = 
          article.querySelector('[data-testid="promotedIndicator"]') !== null ||
          article.textContent.includes('Promoted') ||
		  article.textContent.includes('Reklam') ||
		  article.textContent.includes('bahis') ||
		  article.textContent.includes('finans') ||
          article.textContent.includes('Sponsorlu') ||
          article.textContent.includes('Ad') ||
          article.querySelector('svg[aria-label="Promoted"]') !== null;
        
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
        
        // Reply mi kontrol et - reply'leri atla
        const isReply = article.textContent.includes('Replying to') || 
                       article.textContent.includes('yanıt olarak');
        
        if (isReply) {
          console.log(`Tweet ${currentTweetId} bir reply, atlanıyor`);
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
