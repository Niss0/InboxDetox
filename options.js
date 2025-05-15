// options.js
document.addEventListener('DOMContentLoaded', () => {
    const rulesListDiv = document.getElementById('rulesList');
    const ruleTypeSelect = document.getElementById('ruleType');
    const ruleValueInput = document.getElementById('ruleValue');
    const ruleLabelNameInput = document.getElementById('ruleLabelName');
    const addRuleBtn = document.getElementById('addRuleBtn');

    const enableSpamDetectionCheckbox = document.getElementById('enableSpamDetection');
    const spamKeywordsTextarea = document.getElementById('spamKeywords');
    const spamSenderDomainsTextarea = document.getElementById('spamSenderDomains');

    const suggestedLabelsListDiv = document.getElementById('suggestedLabelsList');

    const processingIntervalInput = document.getElementById('processingInterval');
    const autoCreateLabelsCheckbox = document.getElementById('autoCreateLabels');
    const enablePatternDetectionCheckbox = document.getElementById('enablePatternDetection');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const forceProcessBtn = document.getElementById('forceProcessBtn');
    const lastProcessedP = document.getElementById('lastProcessed');

    const statusDiv = document.getElementById('status');

    let currentSettings = {};
    let currentGmailLabels = {}; // To store {id: name}

    // Tabs
    const tabs = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
        });
    });

    function displayStatus(message, isError = false) {
        statusDiv.textContent = message;
        statusDiv.style.color = isError ? 'red' : 'green';
        setTimeout(() => statusDiv.textContent = '', 3000);
    }

    async function loadSettingsAndLabels() {
        try {
            const response = await chrome.runtime.sendMessage({ action: "getSettings" });
            if (response && response.success) {
                currentSettings = response.settings || {}; // Ensure currentSettings is an object
                currentGmailLabels = response.gmailLabels || {};

                // Populate Rules
                currentSettings.rules = currentSettings.rules || [];
                renderRules();

                // Populate Spam Settings
                enableSpamDetectionCheckbox.checked = currentSettings.enableSpamDetection !== false; // default true
                spamKeywordsTextarea.value = (currentSettings.spamKeywords || []).join('\n');
                spamSenderDomainsTextarea.value = (currentSettings.spamSenderDomains || []).join('\n');


                // Populate General Settings
                processingIntervalInput.value = currentSettings.processingInterval || 5;
                autoCreateLabelsCheckbox.checked = currentSettings.autoCreateLabels === true;
                enablePatternDetectionCheckbox.checked = currentSettings.enablePatternDetection !== false; // default true
                lastProcessedP.textContent = `Last processed: ${currentSettings.lastProcessedTimestamp ? new Date(currentSettings.lastProcessedTimestamp).toLocaleString() : 'N/A'}`;

                loadSuggestedLabels();
            } else {
                displayStatus(`Error loading settings: ${response?.error || 'Unknown error'}`, true);
            }
        } catch (e) {
            displayStatus(`Exception loading settings: ${e.message}`, true);
            console.error(e);
        }
    }

    function renderRules() {
        rulesListDiv.innerHTML = '';
        if (!currentSettings.rules || currentSettings.rules.length === 0) {
            rulesListDiv.innerHTML = '<p>No rules defined yet.</p>';
            return;
        }
        currentSettings.rules.forEach((rule, index) => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            item.innerHTML = `
                <span>Condition: <b>${rule.type}</b> = "${rule.value}", Label: <b>${rule.labelName}</b></span>
                <button data-index="${index}" class="remove-rule danger">Remove</button>
            `;
            rulesListDiv.appendChild(item);
        });

        document.querySelectorAll('.remove-rule').forEach(button => {
            button.addEventListener('click', (e) => {
                removeRule(parseInt(e.target.dataset.index));
            });
        });
    }

    addRuleBtn.addEventListener('click', async () => {
        const type = ruleTypeSelect.value;
        const value = ruleValueInput.value.trim();
        const labelName = ruleLabelNameInput.value.trim();

        if (!value || !labelName) {
            displayStatus('Rule value and label name cannot be empty.', true);
            return;
        }

        // Optional: Check if label exists or offer to create it implicitly via background
        // For now, we assume background will create it if not found.
        // We can also pre-fetch labels and populate a dropdown or autocomplete for labelName.

        currentSettings.rules = currentSettings.rules || [];
        currentSettings.rules.push({ type, value, labelName }); // labelId will be resolved by background
        renderRules();
        ruleValueInput.value = '';
        ruleLabelNameInput.value = ''; // Keep label name for next rule potentially
        displayStatus('Rule added locally. Save all settings to apply.', false);
    });

    function removeRule(index) {
        currentSettings.rules.splice(index, 1);
        renderRules();
        displayStatus('Rule removed locally. Save all settings to apply.', false);
    }

    async function loadSuggestedLabels() {
        try {
            const response = await chrome.runtime.sendMessage({ action: "getSuggestedLabels" });
            if (response && response.success) {
                renderSuggestedLabels(response.suggestedLabels || []);
            } else {
                displayStatus(`Error loading suggestions: ${response?.error || 'Unknown error'}`, true);
            }
        } catch (e) {
            displayStatus(`Exception loading suggestions: ${e.message}`, true);
        }
    }

    function renderSuggestedLabels(suggestions) {
        suggestedLabelsListDiv.innerHTML = '';
        if (suggestions.length === 0) {
            suggestedLabelsListDiv.innerHTML = '<p>No active suggestions.</p>';
            return;
        }
        suggestions.filter(s => s.status === 'pending').forEach(suggestion => { // Only show pending
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `
                <div>
                    Suggested Label: <strong>${suggestion.name}</strong><br>
                    <small>Based on: ${suggestion.basedOnLabel} for domain ${suggestion.basedOnDomain}</small>
                </div>
                <div>
                    <button data-id="${suggestion.id}" class="approve-suggestion">Approve & Create</button>
                    <button data-id="${suggestion.id}" class="reject-suggestion danger">Reject</button>
                </div>
            `;
            suggestedLabelsListDiv.appendChild(item);
        });

        document.querySelectorAll('.approve-suggestion').forEach(button => {
            button.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                const response = await chrome.runtime.sendMessage({ action: "approveSuggestion", suggestionId: id });
                if (response && response.success) {
                    displayStatus(`Suggestion "${response.suggestion.name}" approved. Label created/rule updated.`, false);
                    loadSuggestedLabels(); // Refresh list
                    loadSettingsAndLabels(); // Also refresh rules if auto-create rule is on
                } else {
                    displayStatus(`Error approving suggestion: ${response?.error || 'Unknown error'}`, true);
                }
            });
        });

        document.querySelectorAll('.reject-suggestion').forEach(button => {
            button.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                const response = await chrome.runtime.sendMessage({ action: "rejectSuggestion", suggestionId: id });
                if (response && response.success) {
                    displayStatus('Suggestion rejected.', false);
                    loadSuggestedLabels(); // Refresh list
                } else {
                    displayStatus(`Error rejecting suggestion: ${response?.error || 'Unknown error'}`, true);
                }
            });
        });
    }


    saveSettingsBtn.addEventListener('click', async () => {
        const settingsToSave = {
            rules: currentSettings.rules,
            spamKeywords: spamKeywordsTextarea.value.split('\n').map(k => k.trim()).filter(k => k),
            spamSenderDomains: spamSenderDomainsTextarea.value.split('\n').map(k => k.trim()).filter(k => k),
            enableSpamDetection: enableSpamDetectionCheckbox.checked,
            processingInterval: parseInt(processingIntervalInput.value) || 5,
            autoCreateLabels: autoCreateLabelsCheckbox.checked,
            enablePatternDetection: enablePatternDetectionCheckbox.checked
        };

        try {
            const response = await chrome.runtime.sendMessage({ action: "saveSettings", settings: settingsToSave });
            if (response && response.success) {
                displayStatus('Settings saved successfully!', false);
                currentSettings = {...currentSettings, ...settingsToSave}; // Update local copy
            } else {
                displayStatus(`Error saving settings: ${response?.error || 'Unknown error'}`, true);
            }
        } catch (e) {
            displayStatus(`Exception saving settings: ${e.message}`, true);
        }
    });

    forceProcessBtn.addEventListener('click', async () => {
        forceProcessBtn.disabled = true;
        forceProcessBtn.textContent = "Processing...";
        displayStatus('Requesting manual email processing...', false);
        try {
            const response = await chrome.runtime.sendMessage({ action: "processNow" });
            if (response && response.success) {
                displayStatus(response.message || 'Processing started.', false);
                 setTimeout(loadSettingsAndLabels, 3000); // Refresh last processed time after a bit
            } else {
                displayStatus(`Error starting process: ${response?.message || 'Unknown error'}`, true);
            }
        } catch (e) {
            displayStatus(`Exception triggering process: ${e.message}`, true);
        } finally {
            forceProcessBtn.disabled = false;
            forceProcessBtn.textContent = "Process Emails Now";
        }
    });

    // Listener for messages from background (e.g., to refresh suggestions)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "refreshSuggestions") {
            loadSuggestedLabels();
        }
        if (request.action === "updateLastProcessed") {
             lastProcessedP.textContent = `Last processed: ${request.timestamp ? new Date(request.timestamp).toLocaleString() : 'N/A'}`;
        }
    });

    // Initial load
    loadSettingsAndLabels();
});