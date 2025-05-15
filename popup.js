// popup.js
document.addEventListener('DOMContentLoaded', () => {
    const processNowBtn = document.getElementById('processNowBtn');
    const openOptionsBtn = document.getElementById('openOptionsBtn');
    const lastProcessedP = document.getElementById('lastProcessed');
    const statusMessageP = document.getElementById('statusMessage');
    const authStatusP = document.getElementById('authStatus');

    function displayStatus(message, isError = false) {
        statusMessageP.textContent = message;
        statusMessageP.style.color = isError ? 'red' : 'black';
    }

    async function checkAuthAndLoadInfo() {
        try {
            // Non-interactive check first
            chrome.identity.getAuthToken({ interactive: false }, async (token) => {
                if (chrome.runtime.lastError || !token) {
                    authStatusP.textContent = 'Not signed in.';
                    authStatusP.style.color = 'orange';
                    processNowBtn.textContent = 'Sign In & Process';
                    displayStatus('Click "Sign In" to grant access.', false);
                } else {
                    authStatusP.textContent = 'Authenticated';
                    authStatusP.style.color = 'green';
                    processNowBtn.textContent = 'Process Emails Now';
                    // Load last processed time
                    const response = await chrome.runtime.sendMessage({ action: "getSettings" });
                    if (response && response.success && response.settings) {
                        lastProcessedP.textContent = `Last processed: ${response.settings.lastProcessedTimestamp ? new Date(response.settings.lastProcessedTimestamp).toLocaleString() : 'N/A'}`;
                    }
                }
            });
        } catch (e) {
            authStatusP.textContent = 'Error checking auth.';
            authStatusP.style.color = 'red';
            console.error("Auth check error:", e);
        }
    }


    processNowBtn.addEventListener('click', async () => {
        processNowBtn.disabled = true;
        const originalText = processNowBtn.textContent;
        processNowBtn.textContent = 'Working...';
        displayStatus('Requesting processing...', false);

        try {
            // Check if button is in "Sign In" mode
            if (originalText.includes('Sign In')) {
                 const authResponse = await chrome.runtime.sendMessage({action: "getAuthToken"}); // This is interactive
                 if (authResponse && authResponse.success && authResponse.token) {
                    authStatusP.textContent = 'Authenticated!';
                    authStatusP.style.color = 'green';
                    processNowBtn.textContent = 'Process Emails Now';
                    // Now trigger processing
                    const processResponse = await chrome.runtime.sendMessage({ action: "processNow" });
                    displayStatus(processResponse.message || 'Processing started.', !processResponse.success);

                 } else {
                    displayStatus(authResponse.error || 'Sign-in failed or cancelled.', true);
                    authStatusP.textContent = 'Sign-in required.';
                    processNowBtn.textContent = 'Sign In & Process';
                 }
            } else {
                // Already authenticated, just process
                const response = await chrome.runtime.sendMessage({ action: "processNow" });
                displayStatus(response.message || 'Processing request sent.', !response.success);
                if(response.success) {
                     // Refresh last processed time after a short delay
                    setTimeout(checkAuthAndLoadInfo, 2000);
                }
            }
        } catch (e) {
            displayStatus(`Error: ${e.message}`, true);
            console.error(e);
        } finally {
            processNowBtn.disabled = false;
            // Re-check auth to update button text if it was sign-in
            if (!originalText.includes('Sign In')) {
                 processNowBtn.textContent = originalText;
            } else {
                await checkAuthAndLoadInfo(); // this will set the correct button text
            }
        }
    });

    openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Initial load
    checkAuthAndLoadInfo();
});