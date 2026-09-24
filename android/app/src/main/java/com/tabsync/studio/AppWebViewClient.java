package com.tabsync.studio;

import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class AppWebViewClient extends WebViewClient {
    private final MainActivity activity;

    public AppWebViewClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (request == null || request.getUrl() == null) return true;
        Uri uri = request.getUrl();
        String scheme = uri.getScheme();

        // Enforce strict HTTPS: reject unencrypted HTTP, file://, content://, and arbitrary schemes
        if (!"https".equalsIgnoreCase(scheme)) {
            return true;
        }

        // Restrict navigation strictly to the authorized Mac host
        if (activity != null && !activity.isAllowedHost(uri.getHost(), uri.getPort())) {
            return true;
        }

        return false;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        if (activity != null) {
            activity.onPageLoaded();
        }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);
        if (request != null && request.isForMainFrame() && activity != null) {
            activity.onPageLoadFailed(request.getUrl().toString());
        }
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        if (error != null && error.getCertificate() != null && activity != null) {
            if (activity.verifyCertificateFingerprint(error.getCertificate())) {
                // Verified against pinned Mac host cryptographic fingerprint
                handler.proceed();
                return;
            }
        }

        // Untrusted certificate or fingerprint mismatch: abort connection and notify activity
        handler.cancel();
        if (activity != null) {
            activity.onSslErrorRejected(error);
        }
    }
}
