package com.tabsync.studio;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.net.wifi.WifiManager;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.security.MessageDigest;
import org.json.JSONObject;

public class MainActivity extends Activity implements View.OnClickListener {
    private WebView webView;
    private FrameLayout rootLayout;
    private ScrollView connectDialogContainer;
    private LinearLayout connectDialog;
    private EditText ipInput;
    private EditText pinInput;
    private TextView statusText;
    private Button connectBtn;
    private Button menuBtn;
    private Button discoveredHostBtn;
    private Thread discoveryThread;
    private volatile boolean isDiscovering = false;
    private WifiManager.MulticastLock multicastLock;
    private SharedPreferences prefs;

    private static final String PREF_NAME = "TabSyncPrefs";
    private static final String KEY_MAC_IP = "mac_ip";
    private static final String KEY_PINNED_FINGERPRINT = "pinned_fingerprint";
    private static final String KEY_HOST_ID = "pinned_host_id";
    private static final String KEY_HOST_NAME = "pinned_host_name";
    private static final String DEFAULT_IP = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemUI();

        prefs = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        String savedIp = prefs.getString(KEY_MAC_IP, DEFAULT_IP);

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#080B12"));

        setupWebView();
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        setupConnectDialog(savedIp);
        rootLayout.addView(connectDialogContainer);

        menuBtn = createFloatingMenuButton();
        FrameLayout.LayoutParams btnParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                dpToPx(38)
        );
        btnParams.gravity = Gravity.TOP | Gravity.LEFT;
        btnParams.leftMargin = dpToPx(14);
        btnParams.topMargin = dpToPx(12);
        rootLayout.addView(menuBtn, btnParams);

        setContentView(rootLayout);

        // Check if launched via deep link QR scan (tabsync://pair?...)
        handleIncomingIntent(getIntent(), savedIp);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent, prefs.getString(KEY_MAC_IP, DEFAULT_IP));
    }

    private void handleIncomingIntent(Intent intent, String fallbackIp) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            if (data != null && "tabsync".equalsIgnoreCase(data.getScheme())) {
                String host = data.getQueryParameter("host");
                String port = data.getQueryParameter("port");
                String token = data.getQueryParameter("token");
                String pin = data.getQueryParameter("pin");
                String fp = data.getQueryParameter("fp");
                String hostId = data.getQueryParameter("hostId");
                String hostName = data.getQueryParameter("hostName");

                // Strictly validate incoming parameters
                if (host != null && host.matches("^[a-zA-Z0-9.-]+$")) {
                    int portNum = 4444;
                    if (port != null && port.matches("^[0-9]{1,5}$")) {
                        try {
                            int p = Integer.parseInt(port);
                            if (p >= 1 && p <= 65535) portNum = p;
                        } catch (NumberFormatException ignored) {}
                    }
                    if (token != null && !token.matches("^[a-fA-F0-9]{32}$")) {
                        token = null;
                    }
                    if (pin != null && !pin.matches("^[0-9]{6}$")) {
                        pin = null;
                    }
                    if (fp != null && fp.matches("^[a-fA-F0-9:]{64,95}$")) {
                        prefs.edit().putString(KEY_PINNED_FINGERPRINT, fp).apply();
                    }
                    if (hostId != null && hostId.matches("^[a-zA-Z0-9-_]{4,64}$")) {
                        prefs.edit().putString(KEY_HOST_ID, hostId).apply();
                    }
                    if (hostName != null && !hostName.isEmpty()) {
                        prefs.edit().putString(KEY_HOST_NAME, hostName).apply();
                    }

                    String fullHost = host + ":" + portNum;
                    prefs.edit().putString(KEY_MAC_IP, fullHost).apply();
                    loadTabletUrl(fullHost, token, pin, fp, hostId, hostName);
                    return;
                }
            }
        }

        // Standard launch: load saved host if previously configured
        if (fallbackIp != null && !fallbackIp.trim().isEmpty()) {
            loadTabletUrl(fallbackIp, null, null, null, null, null);
        } else {
            // First run: keep connect dialog open for user input
            showConnectDialog("Enter your Mac's IP (e.g. 192.168.1.x or 10.0.2.2 for emulator):");
        }
    }

    private void setupWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#080B12"));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new AppWebViewClient(this));
    }

    public void onPageLoaded() {
        runOnUiThread(() -> {
            hideSystemUI();
            if (connectDialogContainer != null) {
                connectDialogContainer.setVisibility(View.GONE);
            }
            if (menuBtn != null) {
                menuBtn.bringToFront();
            }
        });
    }

    public void onPageLoadFailed(String url, String reason) {
        runOnUiThread(() -> {
            String msg = "Could not connect to Mac";
            if (reason != null && !reason.isEmpty()) {
                msg += ": " + reason;
            }
            msg += "\n\n1. Ensure TabSync Studio is running on your Mac.\n2. Ensure both devices are on the same Wi-Fi network.\n3. For BlueStacks / Emulators on the same Mac, use IP: 10.0.2.2";
            showConnectDialog(msg);
        });
    }

    private void setupConnectDialog(String initialIp) {
        connectDialogContainer = new ScrollView(this);
        connectDialogContainer.setFillViewport(true);
        FrameLayout.LayoutParams scrollParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        );
        connectDialogContainer.setLayoutParams(scrollParams);

        LinearLayout centeringLayout = new LinearLayout(this);
        centeringLayout.setGravity(Gravity.CENTER);
        centeringLayout.setPadding(dpToPx(16), dpToPx(30), dpToPx(16), dpToPx(30));

        connectDialog = new LinearLayout(this);
        connectDialog.setOrientation(LinearLayout.VERTICAL);
        connectDialog.setGravity(Gravity.CENTER);
        connectDialog.setPadding(dpToPx(28), dpToPx(24), dpToPx(28), dpToPx(24));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#E60F172A"));
        bg.setCornerRadius(dpToPx(18));
        bg.setStroke(dpToPx(1), Color.parseColor("#33FFFFFF"));
        connectDialog.setBackground(bg);

        TextView title = new TextView(this);
        title.setText("⚡ TabSync Studio");
        title.setTextSize(22);
        title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dpToPx(6));
        connectDialog.addView(title);

        statusText = new TextView(this);
        statusText.setText("Enter your MacBook's IP and 6-digit PIN shown on the widget:");
        statusText.setTextSize(13);
        statusText.setTextColor(Color.parseColor("#94A3B8"));
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(0, 0, 0, dpToPx(16));
        connectDialog.addView(statusText);

        // IP input
        ipInput = new EditText(this);
        ipInput.setText(initialIp != null ? initialIp : "");
        ipInput.setHint("Mac IP (e.g. 192.168.1.3 or 10.0.2.2)");
        ipInput.setHintTextColor(Color.parseColor("#64748B"));
        ipInput.setTextColor(Color.WHITE);
        ipInput.setTextSize(14);
        ipInput.setPadding(dpToPx(14), dpToPx(10), dpToPx(14), dpToPx(10));
        ipInput.setSingleLine(true);

        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(Color.parseColor("#22000000"));
        inputBg.setCornerRadius(dpToPx(8));
        inputBg.setStroke(dpToPx(1), Color.parseColor("#33FFFFFF"));
        ipInput.setBackground(inputBg);

        LinearLayout.LayoutParams ipParams = new LinearLayout.LayoutParams(dpToPx(290), dpToPx(44));
        ipParams.bottomMargin = dpToPx(10);
        connectDialog.addView(ipInput, ipParams);

        // PIN input (optional for manual pairing)
        pinInput = new EditText(this);
        pinInput.setHint("6-digit PIN (Optional)");
        pinInput.setHintTextColor(Color.parseColor("#64748B"));
        pinInput.setTextColor(Color.parseColor("#38BDF8"));
        pinInput.setTextSize(14);
        pinInput.setPadding(dpToPx(14), dpToPx(10), dpToPx(14), dpToPx(10));
        pinInput.setSingleLine(true);
        pinInput.setBackground(inputBg);

        LinearLayout.LayoutParams pinParams = new LinearLayout.LayoutParams(dpToPx(290), dpToPx(44));
        pinParams.bottomMargin = dpToPx(16);
        connectDialog.addView(pinInput, pinParams);

        discoveredHostBtn = new Button(this);
        discoveredHostBtn.setVisibility(View.GONE);
        discoveredHostBtn.setTextSize(13);
        discoveredHostBtn.setTextColor(Color.parseColor("#38BDF8"));
        GradientDrawable discBg = new GradientDrawable();
        discBg.setColor(Color.parseColor("#1E293B"));
        discBg.setCornerRadius(dpToPx(8));
        discBg.setStroke(dpToPx(1), Color.parseColor("#0284C7"));
        discoveredHostBtn.setBackground(discBg);
        discoveredHostBtn.setOnClickListener(this);

        LinearLayout.LayoutParams discParams = new LinearLayout.LayoutParams(dpToPx(290), dpToPx(44));
        discParams.bottomMargin = dpToPx(12);
        connectDialog.addView(discoveredHostBtn, discParams);

        connectBtn = new Button(this);
        connectBtn.setText("Connect to Mac");
        connectBtn.setTextColor(Color.WHITE);
        connectBtn.setTextSize(14);

        GradientDrawable btnBg = new GradientDrawable();
        btnBg.setColor(Color.parseColor("#0284C7"));
        btnBg.setCornerRadius(dpToPx(8));
        connectBtn.setBackground(btnBg);
        connectBtn.setOnClickListener(this);

        connectDialog.addView(connectBtn, new LinearLayout.LayoutParams(dpToPx(290), dpToPx(46)));

        TextView tipText = new TextView(this);
        tipText.setText("💡 Tip: In BlueStacks or emulators on the same Mac, use 10.0.2.2 as the IP address.");
        tipText.setTextSize(11);
        tipText.setTextColor(Color.parseColor("#38BDF8"));
        tipText.setGravity(Gravity.CENTER);
        tipText.setPadding(0, dpToPx(14), 0, 0);
        connectDialog.addView(tipText, new LinearLayout.LayoutParams(dpToPx(290), LinearLayout.LayoutParams.WRAP_CONTENT));

        centeringLayout.addView(connectDialog);
        connectDialogContainer.addView(centeringLayout, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT
        ));
    }

    private Button createFloatingMenuButton() {
        Button btn = new Button(this);
        btn.setText("⚙️ Settings");
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(12);
        btn.setPadding(dpToPx(10), dpToPx(6), dpToPx(10), dpToPx(6));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#CC0F172A"));
        bg.setCornerRadius(dpToPx(16));
        bg.setStroke(dpToPx(1), Color.parseColor("#475569"));
        btn.setBackground(bg);
        btn.setOnClickListener(this);
        return btn;
    }

    @Override
    public void onClick(View v) {
        if (v == discoveredHostBtn) {
            String host = (String) discoveredHostBtn.getTag();
            if (host != null && !host.isEmpty()) {
                ipInput.setText(host);
                prefs.edit().putString(KEY_MAC_IP, host).apply();
                loadTabletUrl(host, null, null, null, null, null);
            }
        } else if (v == connectBtn) {
            String ip = ipInput.getText().toString().trim();
            String pin = pinInput != null ? pinInput.getText().toString().trim() : null;
            if (!ip.isEmpty()) {
                prefs.edit().putString(KEY_MAC_IP, ip).apply();
                loadTabletUrl(ip, null, pin, null, null, null);
            } else {
                Toast.makeText(this, "Please enter your Mac's IP address", Toast.LENGTH_SHORT).show();
            }
        } else if (v == menuBtn) {
            if (connectDialogContainer != null) {
                if (connectDialogContainer.getVisibility() == View.VISIBLE) {
                    connectDialogContainer.setVisibility(View.GONE);
                } else {
                    connectDialogContainer.setVisibility(View.VISIBLE);
                    connectDialogContainer.bringToFront();
                }
            }
        }
    }

    private void startNetworkDiscovery() {
        if (isDiscovering) return;
        isDiscovering = true;

        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                multicastLock = wm.createMulticastLock("TabSyncDiscovery");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {}

        discoveryThread = new Thread(() -> {
            DatagramSocket socket = null;
            try {
                try {
                    socket = new DatagramSocket(null);
                    socket.setReuseAddress(true);
                    socket.bind(new java.net.InetSocketAddress(44445));
                } catch (Exception be) {
                    socket = new DatagramSocket(); // fallback to ephemeral port
                }
                socket.setBroadcast(true);
                socket.setSoTimeout(3000);

                // Broadcast probe
                sendProbe(socket);

                byte[] buf = new byte[2048];
                while (isDiscovering) {
                    try {
                        DatagramPacket packet = new DatagramPacket(buf, buf.length);
                        socket.receive(packet);
                        String data = new String(packet.getData(), 0, packet.getLength(), "UTF-8");
                        if (data.contains("tabsync_beacon") || data.contains("tabsync_host_presence")) {
                            JSONObject json = new JSONObject(data);
                            String hostName = json.optString("hostName", "MacBook Pro");
                            String hostIp = json.optString("hostIp", packet.getAddress().getHostAddress());
                            int port = json.optInt("port", 4444);
                            String fp = json.optString("fingerprint", null);
                            String hostId = json.optString("hostId", null);

                            final String hostTag = hostIp + ":" + port;
                            runOnUiThread(() -> {
                                if (discoveredHostBtn != null) {
                                    discoveredHostBtn.setText("⚡ " + hostName + " (Tap to connect)");
                                    discoveredHostBtn.setTag(hostTag);
                                    discoveredHostBtn.setVisibility(View.VISIBLE);
                                }
                                if (fp != null && !fp.isEmpty()) {
                                    prefs.edit().putString(KEY_PINNED_FINGERPRINT, fp).apply();
                                }
                                if (hostId != null && !hostId.isEmpty()) {
                                    prefs.edit().putString(KEY_HOST_ID, hostId).apply();
                                }
                            });
                        }
                    } catch (java.net.SocketTimeoutException e) {
                        sendProbe(socket);
                    }
                }
            } catch (Exception e) {
                // Ignore transient socket exceptions
            } finally {
                if (socket != null && !socket.isClosed()) {
                    socket.close();
                }
            }
        });
        discoveryThread.setDaemon(true);
        discoveryThread.start();
    }

    private void sendProbe(DatagramSocket socket) {
        try {
            byte[] probe = "TABSYNC_DISCOVER".getBytes("UTF-8");
            DatagramPacket probePacket = new DatagramPacket(
                    probe, probe.length,
                    InetAddress.getByName("255.255.255.255"), 44445
            );
            socket.send(probePacket);
        } catch (Exception ignored) {}
    }

    private void stopNetworkDiscovery() {
        isDiscovering = false;
        if (discoveryThread != null) {
            discoveryThread.interrupt();
            discoveryThread = null;
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            try { multicastLock.release(); } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        startNetworkDiscovery();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopNetworkDiscovery();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopNetworkDiscovery();
    }

    private void loadTabletUrl(String ipOrHost, String token, String pin, String fp, String hostId, String hostName) {
        String formatted = ipOrHost.trim();
        if (formatted.isEmpty()) {
            showConnectDialog("Please enter your Mac's IP address.");
            return;
        }

        // Disallow insecure cleartext http:// and enforce strict https://
        if (formatted.startsWith("http://")) {
            formatted = formatted.substring(7);
        }
        if (!formatted.startsWith("https://")) {
            formatted = "https://" + formatted;
        }
        if (!formatted.contains(":") || formatted.matches("https://[^:]+$")) {
            formatted = formatted + ":4444";
        }
        if (!formatted.contains("/tablet")) {
            formatted = formatted + "/tablet";
        }

        StringBuilder urlBuilder = new StringBuilder(formatted);
        // Transmit credentials strictly via URL hash fragment (#token=...&pin=...) to prevent HTTP query string / access log leakage
        if ((token != null && !token.isEmpty()) || (pin != null && !pin.isEmpty()) || (fp != null && !fp.isEmpty()) || (hostId != null && !hostId.isEmpty())) {
            urlBuilder.append("#");
            boolean first = true;
            if (token != null && !token.isEmpty()) {
                urlBuilder.append("token=").append(Uri.encode(token));
                first = false;
            }
            if (pin != null && !pin.isEmpty()) {
                if (!first) urlBuilder.append("&");
                urlBuilder.append("pin=").append(Uri.encode(pin));
                first = false;
            }
            if (fp != null && !fp.isEmpty()) {
                if (!first) urlBuilder.append("&");
                urlBuilder.append("fp=").append(Uri.encode(fp));
                first = false;
            }
            if (hostId != null && !hostId.isEmpty()) {
                if (!first) urlBuilder.append("&");
                urlBuilder.append("hostId=").append(Uri.encode(hostId));
                first = false;
            }
            if (hostName != null && !hostName.isEmpty()) {
                if (!first) urlBuilder.append("&");
                urlBuilder.append("hostName=").append(Uri.encode(hostName));
            }
        }

        String targetUrl = urlBuilder.toString();
        statusText.setText("Connecting to Mac (" + ipOrHost + ")...");
        Toast.makeText(this, "Connecting to Mac...", Toast.LENGTH_SHORT).show();
        webView.loadUrl(targetUrl);
    }

    public String extractFingerprint(SslCertificate cert) {
        if (cert == null) return null;
        Bundle bundle = SslCertificate.saveState(cert);
        byte[] bytes = bundle != null ? bundle.getByteArray("x509-certificate") : null;
        if (bytes != null) {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest(bytes);
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < digest.length; i++) {
                    sb.append(String.format("%02x", digest[i]));
                    if (i < digest.length - 1) sb.append(":");
                }
                return sb.toString();
            } catch (Exception ignored) {}
        }
        return null;
    }

    public boolean verifyCertificateFingerprint(SslCertificate cert) {
        if (cert == null) return false;
        String pinned = prefs.getString(KEY_PINNED_FINGERPRINT, null);
        if (pinned == null || pinned.trim().isEmpty()) {
            return false;
        }
        String certFp = extractFingerprint(cert);
        if (certFp == null) return false;
        String cleanCertFp = certFp.replace(":", "").toLowerCase();
        String cleanPinned = pinned.replace(":", "").toLowerCase();
        return cleanCertFp.equals(cleanPinned);
    }

    public void promptTrustCertificate(final SslErrorHandler handler, final SslError error) {
        runOnUiThread(() -> {
            if (error == null || error.getCertificate() == null) {
                if (handler != null) handler.cancel();
                showConnectDialog("TLS connection failed: Invalid certificate.");
                return;
            }
            final String certFp = extractFingerprint(error.getCertificate());
            final String pinned = prefs.getString(KEY_PINNED_FINGERPRINT, null);

            if (pinned == null || pinned.isEmpty()) {
                // First-time manual connection prompt: user verifies fingerprint against Mac floating widget
                new AlertDialog.Builder(this)
                        .setTitle("🔒 Trust Mac Host Certificate?")
                        .setMessage("This Mac presents TLS Certificate Fingerprint:\n\n" + certFp +
                                "\n\nPlease confirm this matches the fingerprint displayed on your Mac's TabSync Studio widget.")
                        .setPositiveButton("Trust & Connect", (dialog, which) -> {
                            prefs.edit().putString(KEY_PINNED_FINGERPRINT, certFp).apply();
                            if (handler != null) {
                                handler.proceed();
                            }
                        })
                        .setNegativeButton("Cancel", (dialog, which) -> {
                            if (handler != null) {
                                handler.cancel();
                            }
                            showConnectDialog("Connection cancelled: Untrusted host certificate.");
                        })
                        .setCancelable(false)
                        .show();
            } else {
                // Fingerprint mismatch alert: potential MITM or unexpected host replacement
                if (handler != null) {
                    handler.cancel();
                }
                new AlertDialog.Builder(this)
                        .setTitle("⚠️ Security Warning: Host Fingerprint Mismatch!")
                        .setMessage("The Mac certificate fingerprint changed!\n\nExpected:\n" + pinned +
                                "\n\nReceived:\n" + certFp +
                                "\n\nConnection aborted to protect your device from unauthorized interception. To connect to a new Mac, please scan its QR code to re-pair.")
                        .setPositiveButton("Dismiss", (dialog, which) -> {
                            showConnectDialog("Connection aborted: Host fingerprint mismatch.");
                        })
                        .setCancelable(false)
                        .show();
            }
        });
    }

    public boolean isAllowedHost(String host, int port) {
        if (host == null) return false;
        String saved = prefs.getString(KEY_MAC_IP, DEFAULT_IP);
        if (saved == null || saved.isEmpty()) {
            return host.equalsIgnoreCase("localhost") || host.equalsIgnoreCase("127.0.0.1") || host.equalsIgnoreCase("10.0.2.2");
        }
        String cleanSaved = saved.replace("https://", "").replace("http://", "");
        if (cleanSaved.contains("/")) cleanSaved = cleanSaved.substring(0, cleanSaved.indexOf('/'));
        String savedHost = cleanSaved.contains(":") ? cleanSaved.substring(0, cleanSaved.indexOf(':')) : cleanSaved;
        return host.equalsIgnoreCase(savedHost)
                || host.equalsIgnoreCase("localhost")
                || host.equalsIgnoreCase("127.0.0.1")
                || host.equalsIgnoreCase("10.0.2.2");
    }

    private void showConnectDialog(String msg) {
        runOnUiThread(() -> {
            if (statusText != null && msg != null) {
                statusText.setText(msg);
            }
            if (connectDialogContainer != null) {
                connectDialogContainer.setVisibility(View.VISIBLE);
                connectDialogContainer.bringToFront();
            }
            if (menuBtn != null) {
                menuBtn.bringToFront();
            }
        });
    }

    public void hideSystemUI() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUI();
        }
    }

    private int dpToPx(int dp) {
        return (int) (dp * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    public void onBackPressed() {
        if (connectDialogContainer != null && connectDialogContainer.getVisibility() == View.VISIBLE) {
            connectDialogContainer.setVisibility(View.GONE);
        } else if (connectDialogContainer != null) {
            connectDialogContainer.setVisibility(View.VISIBLE);
            connectDialogContainer.bringToFront();
        } else if (webView != null && webView.canGoBack()) {
            webView.goBack();
        }
    }
}
