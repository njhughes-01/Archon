package gateway

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// NewProxy forwards every request to the API, adding the hop headers it expects.
func NewProxy(upstream *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.Header.Set("X-Forwarded-Host", r.Host)
		r.Header.Set("X-Request-Start", r.Header.Get("X-Request-Start"))
		r.Host = upstream.Host
	}
	return proxy
}
