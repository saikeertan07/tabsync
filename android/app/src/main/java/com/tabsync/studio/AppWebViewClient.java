package com.tabsync.studio;

import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class AppWebViewClient extends WebViewClient {
    private final MainActivity activity;
    private boolean pageHasError = false;

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

        // Restrict navigation strictly to authorized host
        if (activity != null && !activity.isAllowedHost(uri.getHost(), uri.getPort())) {
            return true;
        }

        return false;
    }

    @SuppressWarnings("deprecation")
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        if (url == null) return true;
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme)) {
            return true;
        }
        if (activity != null && !activity.isAllowedHost(uri.getHost(), uri.getPort())) {
            return true;
        }
        return false;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        pageHasError = false;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);
        if (request != null && request.isForMainFrame()) {
            pageHasError = true;
            String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
            String desc = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && error != null)
                    ? error.getDescription().toString()
                    : "Connection error";
            if (activity != null) {
                activity.onPageLoadFailed(failingUrl, desc);
            }
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
        super.onReceivedError(view, errorCode, description, failingUrl);
        pageHasError = true;
        if (activity != null) {
            activity.onPageLoadFailed(failingUrl != null ? failingUrl : "", description);
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

        // Do NOT cancel immediately! Forward handler to activity so user can verify & trust fingerprint
        pageHasError = true;
        if (activity != null) {
            activity.promptTrustCertificate(handler, error);
        } else {
            handler.cancel();
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        // CRITICAL: Only transition to loaded state if the page did not encounter an error
        if (!pageHasError && url != null && !url.equals("about:blank") && activity != null) {
            activity.onPageLoaded();
        }
    }
}
