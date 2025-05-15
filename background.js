// background.js

// --- Configuration & Globals ---
const GMAIL_API_BASE_URL = 'https://www.googleapis.com/gmail/v1/users/me';
const PROCESSING_ALARM_NAME = 'emailProcessingAlarm';
const DEFAULT_PROCESSING_INTERVAL_MINUTES = 5;
const SPAM_LABEL_NAME = 'ExtensionSpam'; // Custom spam label
const MIN_EMAILS_FOR_PATTERN = 3; // Min emails from a domain with same manual label to trigger suggestion

let userSettings = {
  rules: [], // { type: 'sender/subject/keyword', value: 'string', labelId: 'labelId', labelName: 'Friendly Label Name'}
  spamKeywords: ['win a prize', 'free money', 'urgent action required', 'limited time offer', 'congratulations you won'],
  spamSenderDomains: [], // e.g., ['shady.biz', 'freestuff.xyz'] - less reliable, use with caution
  autoCreateLabels: false, // Whether to auto-create labels from patterns or just suggest
  processingInterval: DEFAULT_PROCESSING_INTERVAL_MINUTES,
  enableSpamDetection: true,
  enablePatternDetection: true,
  lastProcessedTimestamp: null
};

let gmailLabels = {}; // Cache for Gmail labels {id: name}

// --- Authentication & API Helpers ---

async function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        console.error('Auth Error:', chrome.runtime.lastError.message);
        reject(chrome.runtime.lastError);
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchGmailApi(endpoint, method = 'GET', body = null) {
  try {
    const token = await getAuthToken();
    if (!token) {
      console.error('No auth token available.');
      // Potentially trigger interactive auth or notify user
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Authentication Required',
        message: 'Gmail Organizer needs you to sign in to access your emails.',
        priority: 2
      });
      await getAuthToken(true); // Attempt interactive auth
      return null; // Or throw an error to stop processing
    }

    const headers = new Headers({
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    });

    const config = { method, headers };
    if (body) {
      config.body = JSON.stringify(body);
    }

    const response = await fetch(`${GMAIL_API_BASE_URL}${endpoint}`, config);

    if (response.status === 401) { // Token might have expired or been revoked
      console.warn('Gmail API returned 401, attempting to remove cached token and retry interactive auth.');
      chrome.identity.removeCachedAuthToken({ token }, async () => {
        await getAuthToken(true); // Re-authenticate interactively
      });
      throw new Error('Unauthorized. Please re-authenticate.');
    }
    if (!response.ok) {
      const errorData = await response.json();
      console.error(`Gmail API Error (${response.status}): ${errorData.error.message}`);
      throw new Error(`API Error: ${errorData.error.message}`);
    }
    return response.json();
  } catch (error) {
    console.error('Error in fetchGmailApi:', error);
    // Notify the user about API errors if they are persistent
    if (error.message.includes('API Error') || error.message.includes('NetworkError')) {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Gmail API Error',
            message: `Could not connect to Gmail: ${error.message}. Please check your connection or try again later.`,
            priority: 2
        });
    }
    throw error; // Re-throw to be caught by calling function
  }
}

async function getLabels() {
  try {
    const data = await fetchGmailApi('/labels');
    gmailLabels = {}; // Reset cache
    if (data && data.labels) {
      data.labels.forEach(label => {
        gmailLabels[label.id] = label.name;
      });
      return gmailLabels;
    }
    return {};
  } catch (error) {
    console.error('Error fetching labels:', error);
    return {}; // Return empty or cached if error
  }
}

async function createLabelIfNeeded(labelName) {
  await getLabels(); // Ensure local cache is up-to-date
  let existingLabelId = Object.keys(gmailLabels).find(id => gmailLabels[id].toLowerCase() === labelName.toLowerCase());

  if (existingLabelId) {
    return existingLabelId;
  }

  try {
    console.log(`Creating label: ${labelName}`);
    const newLabel = await fetchGmailApi('/labels', 'POST', {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    });
    if (newLabel && newLabel.id) {
      gmailLabels[newLabel.id] = newLabel.name; // Update cache
      return newLabel.id;
    }
  } catch (error) {
    console.error(`Error creating label "${labelName}":`, error);
    // Notify user about failure to create label
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Label Creation Failed',
        message: `Could not create label: ${labelName}. Error: ${error.message}`,
        priority: 1
    });
  }
  return null;
}

async function applyLabelsToMessage(messageId, labelIdsToAdd, labelIdsToRemove = []) {
  if (!labelIdsToAdd.length && !labelIdsToRemove.length) return;
  try {
    await fetchGmailApi(`/messages/${messageId}/modify`, 'POST', {
      addLabelIds: labelIdsToAdd,
      removeLabelIds: labelIdsToRemove
    });
    console.log(`Labels modified for message ${messageId}. Added: ${labelIdsToAdd.join(', ')}`);
  } catch (error) {
    console.error(`Error applying labels to message ${messageId}:`, error);
  }
}

// --- Core Email Processing Logic ---

function messageMatchesRule(message, rule) {
  const subject = message.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
  const sender = message.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
  // Basic snippet decoding for keyword search (can be improved for full body)
  let bodySnippet = message.snippet || '';
  if (message.payload.parts) { // Try to get some text part
      const textPart = message.payload.parts.find(p => p.mimeType === 'text/plain' && p.body && p.body.data);
      if (textPart) {
          try {
            bodySnippet += ' ' + atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          } catch (e) { console.warn("Error decoding body part:", e); }
      }
  }


  switch (rule.type) {
    case 'sender':
      return sender.toLowerCase().includes(rule.value.toLowerCase());
    case 'subject':
      return subject.toLowerCase().includes(rule.value.toLowerCase());
    case 'keyword': // Searches in subject or snippet/body
      return subject.toLowerCase().includes(rule.value.toLowerCase()) ||
             bodySnippet.toLowerCase().includes(rule.value.toLowerCase());
    default:
      return false;
  }
}

function isSpam(message) {
  if (!userSettings.enableSpamDetection) return false;

  const subject = message.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value.toLowerCase() || '';
  const senderHeader = message.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value.toLowerCase() || '';
  const senderDomain = senderHeader.substring(senderHeader.lastIndexOf('@') + 1).replace('>', '');

  // Keyword check
  for (const keyword of userSettings.spamKeywords) {
    if (subject.includes(keyword.toLowerCase())) {
      console.log(`Spam detected (keyword: ${keyword}) in subject: ${subject}`);
      return true;
    }
  }

  // Suspicious sender domain (simple TLD check, can be expanded)
  for (const domain of userSettings.spamSenderDomains) {
      if (senderDomain.endsWith(domain.toLowerCase())) {
          console.log(`Spam detected (domain: ${domain}) from sender: ${senderHeader}`);
          return true;
      }
  }

  // Excessive punctuation in subject (example heuristic)
  if ((subject.match(/[!]{2,}/g) || []).length > 0 || (subject.match(/[?]{2,}/g) || []).length > 0) {
      console.log(`Spam detected (excessive punctuation) in subject: ${subject}`);
      return true;
  }

  // Add more heuristics: sender has no proper TLD (e.g. just "user@localhost")
  // This is a naive check and might have false positives. A proper TLD list or regex would be better.
  if (senderDomain && !senderDomain.includes('.') && senderDomain !== 'localhost') {
    console.log(`Spam detected (suspicious TLD: ${senderDomain}) from sender: ${senderHeader}`);
    return true;
  }


  return false;
}

async function processEmail(message) {
  try {
    const fullMessage = await fetchGmailApi(`/messages/${message.id}?format=full`);
    if (!fullMessage || !fullMessage.payload || !fullMessage.payload.headers) {
      console.warn('Could not fetch full message details for:', message.id);
      return;
    }

    let labelsToAdd = [];
    let appliedRule = false;

    // 1. Spam Detection
    if (isSpam(fullMessage)) {
      const spamLabelId = await createLabelIfNeeded(SPAM_LABEL_NAME);
      if (spamLabelId) {
        labelsToAdd.push(spamLabelId);
        console.log(`Message ${message.id} marked as spam.`);
      }
    } else {
      // 2. Apply User-Defined Rules
      for (const rule of userSettings.rules) {
        if (messageMatchesRule(fullMessage, rule)) {
          const targetLabelId = rule.labelId || await createLabelIfNeeded(rule.labelName); // Prefer ID if stored
          if (targetLabelId) {
            labelsToAdd.push(targetLabelId);
            // For pattern detection, store which rule/label was applied
            // This is a simplified example; more robust tracking might be needed
            await chrome.storage.local.set({ [`messageRule_${message.id}`]: { labelId: targetLabelId, labelName: gmailLabels[targetLabelId] || rule.labelName }});
            console.log(`Rule matched for message ${message.id}. Applying label: ${gmailLabels[targetLabelId] || rule.labelName}`);
            appliedRule = true;
            break; // Apply first matching rule, or configure for multiple
          }
        }
      }
    }

    if (labelsToAdd.length > 0) {
      // Remove 'UNREAD' to mark as processed by our rules, and potentially 'INBOX' if moving to a specific label that acts as an archive.
      // For simplicity, just add labels. To also archive, add 'INBOX' to labelIdsToRemove if a non-spam label is applied.
      await applyLabelsToMessage(message.id, labelsToAdd, ['UNREAD']);
    }

    // 3. Pattern Detection (after rules are applied)
    // This part is more complex and needs careful state management.
    // For this example, it's a placeholder for a more robust implementation.
    // The idea: if multiple emails from `domain.com` get label `X`, suggest `X - domain.com`
    if (appliedRule && userSettings.enablePatternDetection) {
        await analyzeForPatterns(fullMessage, labelsToAdd);
    }


  } catch (error) {
    console.error(`Error processing email ${message.id}:`, error);
  }
}

async function analyzeForPatterns(message, appliedLabelIds) {
    if (!appliedLabelIds || appliedLabelIds.length === 0) return;

    const senderHeader = message.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
    const match = senderHeader.match(/@([\w.-]+)/);
    if (!match || !match[1]) return; // No domain found
    const senderDomain = match[1];

    // Only consider manually applied-like labels for pattern (not spam)
    const primaryAppliedLabelId = appliedLabelIds.find(id => gmailLabels[id] !== SPAM_LABEL_NAME);
    if (!primaryAppliedLabelId) return;

    const primaryAppliedLabelName = gmailLabels[primaryAppliedLabelId];

    let { domainLabelCounts = {} } = await chrome.storage.local.get('domainLabelCounts');
    const key = `${senderDomain}:::${primaryAppliedLabelId}`; // Domain + LabelID composite key
    domainLabelCounts[key] = (domainLabelCounts[key] || 0) + 1;

    await chrome.storage.local.set({ domainLabelCounts });

    if (domainLabelCounts[key] >= MIN_EMAILS_FOR_PATTERN) {
        const suggestedLabelName = `${primaryAppliedLabelName} - ${senderDomain}`;
        // Check if this suggestion or a similar label already exists or was suggested
        let { suggestedLabels = [] } = await chrome.storage.local.get('suggestedLabels');
        const existingSuggestion = suggestedLabels.find(s => s.name.toLowerCase() === suggestedLabelName.toLowerCase());
        const labelAlreadyExists = Object.values(gmailLabels).some(name => name.toLowerCase() === suggestedLabelName.toLowerCase());

        if (!existingSuggestion && !labelAlreadyExists) {
            const newSuggestion = {
                id: `sugg_${Date.now()}`, // Unique ID for suggestion
                name: suggestedLabelName,
                basedOnDomain: senderDomain,
                basedOnLabel: primaryAppliedLabelName,
                basedOnLabelId: primaryAppliedLabelId,
                status: 'pending' // pending, approved, rejected
            };
            suggestedLabels.push(newSuggestion);
            await chrome.storage.local.set({ suggestedLabels });
            console.log(`New label suggestion: ${suggestedLabelName}`);

            chrome.notifications.create(`suggestion_${newSuggestion.id}`, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'New Label Suggestion',
                message: `Suggest creating label: "${suggestedLabelName}" for emails from ${senderDomain} currently labeled "${primaryAppliedLabelName}"?`,
                buttons: [{ title: 'Approve & Create' }, { title: 'Reject' }],
                priority: 1,
                requireInteraction: true // Keep notification until user interacts
            });
        }
    }
}


async function processUnreadEmails() {
  console.log('Starting email processing cycle...');
  await loadSettings(); // Ensure settings are fresh
  await getLabels(); // Refresh labels

  try {
    const data = await fetchGmailApi('/messages?q=is:unread'); // Fetch unread emails
    if (data && data.messages && data.messages.length > 0) {
      console.log(`Found ${data.messages.length} unread emails.`);
      // Process a few at a time to avoid hitting API limits too quickly
      // and to allow other operations.
      const emailsToProcess = data.messages.slice(0, 10); // Process up to 10
      for (const message of emailsToProcess) {
        await processEmail(message);
      }
      if (data.messages.length > 10) {
          console.log(`More unread emails exist, will process in next cycle.`);
      }
    } else {
      console.log('No unread emails found.');
    }
    userSettings.lastProcessedTimestamp = new Date().toISOString();
    await chrome.storage.local.set({ lastProcessedTimestamp: userSettings.lastProcessedTimestamp });

  } catch (error) {
    console.error('Error fetching or processing unread emails:', error);
    // Potentially back off the alarm if there are persistent API errors
    if (error.message.includes('API Error') || error.message.includes('Unauthorized')) {
        console.warn("API error during processing, might delay next alarm.");
        // Consider logic here to temporarily increase alarm delay
    }
  }
  console.log('Email processing cycle finished.');
}

// --- Settings Management ---
async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(null, (loadedData) => { // Get all stored sync data
      if (chrome.runtime.lastError) {
        console.error("Error loading settings:", chrome.runtime.lastError);
      } else {
        // Merge defaults with loaded data
        userSettings = {
          ...userSettings, // Start with defaults
          ...loadedData.userSettings // Override with stored if they exist
        };
        // Ensure essential arrays exist if not in storage
        userSettings.rules = userSettings.rules || [];
        userSettings.spamKeywords = userSettings.spamKeywords || ['win a prize', 'free money', 'urgent action required', 'limited time offer', 'congratulations you won'];
        userSettings.spamSenderDomains = userSettings.spamSenderDomains || [];

        if (loadedData.lastProcessedTimestamp) {
          userSettings.lastProcessedTimestamp = loadedData.lastProcessedTimestamp;
        }
      }
      console.log('Settings loaded:', userSettings);
      resolve();
    });
  });
}


async function saveSettings() {
  // Only save the 'userSettings' part to avoid saving gmailLabels or other dynamic states to sync
  const settingsToSave = {
    rules: userSettings.rules,
    spamKeywords: userSettings.spamKeywords,
    spamSenderDomains: userSettings.spamSenderDomains,
    autoCreateLabels: userSettings.autoCreateLabels,
    processingInterval: userSettings.processingInterval,
    enableSpamDetection: userSettings.enableSpamDetection,
    enablePatternDetection: userSettings.enablePatternDetection,
  };
  return new Promise(resolve => {
    chrome.storage.sync.set({ userSettings: settingsToSave }, () => {
      if (chrome.runtime.lastError) {
        console.error("Error saving settings:", chrome.runtime.lastError);
      } else {
        console.log('Settings saved.');
      }
      resolve();
    });
  });
}


// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('Extension installed or updated.');
  await loadSettings(); // Load settings or defaults
  await saveSettings(); // Save initial settings/defaults
  await getLabels(); // Initial fetch of Gmail labels

  // Setup periodic alarm
  chrome.alarms.get(PROCESSING_ALARM_NAME, (alarm) => {
      if (!alarm || alarm.periodInMinutes !== userSettings.processingInterval) {
          chrome.alarms.create(PROCESSING_ALARM_NAME, {
            delayInMinutes: 1, // Start after 1 minute
            periodInMinutes: userSettings.processingInterval
          });
          console.log(`Processing alarm set for every ${userSettings.processingInterval} minutes.`);
      }
  });

  if (details.reason === 'install') {
    // Open options page on first install
    chrome.runtime.openOptionsPage();
    // Attempt initial authentication
    getAuthToken(true).then(token => {
        if (token) {
            console.log("Initial authentication successful.");
            processUnreadEmails(); // Optionally run first process
        } else {
            console.warn("Initial authentication failed or was skipped by user.");
        }
    }).catch(err => console.error("Error during initial auth:", err));
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PROCESSING_ALARM_NAME) {
    console.log('Alarm triggered:', alarm.name);
    // Check if user is signed in before processing
    const token = await getAuthToken(false); // non-interactive check
    if (token) {
        await processUnreadEmails();
    } else {
        console.warn("User not authenticated, skipping email processing.");
        // Optionally notify user to sign in
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Authentication Needed',
            message: 'Gmail Organizer needs you to sign in to process emails. Click the extension icon.',
            priority: 1
        });
    }
  }
});

// Listen for messages from popup or options page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (request.action === "getAuthToken") {
      try {
        const token = await getAuthToken(true); // Interactive
        sendResponse({ success: true, token: token });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    } else if (request.action === "processNow") {
      console.log("Manual process trigger received.");
      const token = await getAuthToken(false);
      if (token) {
        await processUnreadEmails();
        sendResponse({ success: true, message: "Processing started." });
      } else {
        sendResponse({ success: false, message: "Authentication required. Please click the extension icon to sign in."});
        // Trigger interactive auth if manual process fails due to no token
        await getAuthToken(true);
      }
    } else if (request.action === "getSettings") {
      await loadSettings(); // Ensure fresh
      sendResponse({ success: true, settings: userSettings, gmailLabels: await getLabels() });
    } else if (request.action === "saveSettings") {
      userSettings = { ...userSettings, ...request.settings };
      await saveSettings();
      // If interval changed, update alarm
      chrome.alarms.get(PROCESSING_ALARM_NAME, (alarm) => {
          if (alarm && alarm.periodInMinutes !== userSettings.processingInterval) {
              chrome.alarms.create(PROCESSING_ALARM_NAME, {
                delayInMinutes: 1,
                periodInMinutes: userSettings.processingInterval
              });
              console.log(`Processing alarm updated to every ${userSettings.processingInterval} minutes.`);
          }
      });
      sendResponse({ success: true });
    } else if (request.action === "getSuggestedLabels") {
        let { suggestedLabels = [] } = await chrome.storage.local.get('suggestedLabels');
        sendResponse({ success: true, suggestedLabels });
    } else if (request.action === "approveSuggestion") {
        let { suggestedLabels = [] } = await chrome.storage.local.get('suggestedLabels');
        const suggestion = suggestedLabels.find(s => s.id === request.suggestionId);
        if (suggestion) {
            const newLabelId = await createLabelIfNeeded(suggestion.name);
            if (newLabelId) {
                suggestion.status = 'approved';
                suggestion.createdLabelId = newLabelId;
                // Optionally, add this new label as an automatic rule
                if (userSettings.autoCreateLabels) { // Or a separate setting for auto-creating RULES from suggestions
                    userSettings.rules.push({
                        type: 'sender', // Assuming domain-based suggestions become sender rules
                        value: `@${suggestion.basedOnDomain}`, // Or more specific if possible
                        labelId: newLabelId,
                        labelName: suggestion.name
                    });
                    await saveSettings();
                }
            } else {
                suggestion.status = 'failed_creation'; // Label creation failed
            }
            await chrome.storage.local.set({ suggestedLabels });
            sendResponse({ success: true, suggestion });
        } else {
            sendResponse({ success: false, message: 'Suggestion not found.' });
        }
    } else if (request.action === "rejectSuggestion") {
        let { suggestedLabels = [] } = await chrome.storage.local.get('suggestedLabels');
        const suggestionIndex = suggestedLabels.findIndex(s => s.id === request.suggestionId);
        if (suggestionIndex > -1) {
            suggestedLabels[suggestionIndex].status = 'rejected';
            await chrome.storage.local.set({ suggestedLabels });
            sendResponse({ success: true, suggestionId: request.suggestionId });
        } else {
            sendResponse({ success: false, message: 'Suggestion not found.' });
        }
    } else if (request.action === "clearNotification") {
        chrome.notifications.clear(request.notificationId, (wasCleared) => {
            console.log(`Notification ${request.notificationId} cleared: ${wasCleared}`);
        });
        sendResponse({ success: true });
    }
    // Indicate that sendResponse will be called asynchronously
    return true;
  })();
  return true; // Keep message channel open for async sendResponse
});


// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    console.log(`Notification button clicked: ${notificationId}, button index: ${buttonIndex}`);
    if (notificationId.startsWith('suggestion_')) {
        const suggestionId = notificationId.substring('suggestion_'.length);
        let { suggestedLabels = [] } = await chrome.storage.local.get('suggestedLabels');
        const suggestion = suggestedLabels.find(s => s.id === suggestionId);

        if (suggestion) {
            if (buttonIndex === 0) { // Approve & Create
                const newLabelId = await createLabelIfNeeded(suggestion.name);
                if (newLabelId) {
                    suggestion.status = 'approved';
                    suggestion.createdLabelId = newLabelId;
                    // Optionally, add this new label as an automatic rule (as in approveSuggestion handler)
                    // This part can be refactored into a common function
                    if (userSettings.autoCreateLabels) {
                         userSettings.rules.push({
                            type: 'sender',
                            value: `@${suggestion.basedOnDomain}`,
                            labelId: newLabelId,
                            labelName: suggestion.name
                        });
                        await saveSettings();
                        console.log(`Rule auto-created for approved suggestion: ${suggestion.name}`);
                    }
                    console.log(`Suggestion approved and label "${suggestion.name}" created/found.`);
                     // Optionally, find emails that would match this new rule and label them now
                } else {
                    suggestion.status = 'failed_creation';
                    console.error(`Failed to create label for suggestion: ${suggestion.name}`);
                }
            } else if (buttonIndex === 1) { // Reject
                suggestion.status = 'rejected';
                console.log(`Suggestion rejected: ${suggestion.name}`);
            }
            await chrome.storage.local.set({ suggestedLabels });
            // Inform options page if open to refresh
            chrome.runtime.sendMessage({ action: "refreshSuggestions" });
        }
    }
    chrome.notifications.clear(notificationId);
});


// Initial load of settings when service worker starts (not just onInstalled)
loadSettings().then(() => {
  console.log("Background script initialized, settings loaded.");
  // Schedule the alarm if not already set (e.g., after browser restart)
  chrome.alarms.get(PROCESSING_ALARM_NAME, (alarm) => {
      if (!alarm) {
          chrome.alarms.create(PROCESSING_ALARM_NAME, {
            delayInMinutes: 1,
            periodInMinutes: userSettings.processingInterval || DEFAULT_PROCESSING_INTERVAL_MINUTES
          });
          console.log(`Processing alarm (re)set on SW start for every ${userSettings.processingInterval || DEFAULT_PROCESSING_INTERVAL_MINUTES} minutes.`);
      }
  });
});