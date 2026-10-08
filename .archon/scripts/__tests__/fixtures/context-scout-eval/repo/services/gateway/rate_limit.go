package gateway

import (
	"sync"
	"time"
)

// Limiter allows at most Burst requests per client in any Window.
type Limiter struct {
	Burst  int
	Window time.Duration

	mu   sync.Mutex
	seen map[string][]time.Time
}

// Allow records one request for the client and reports whether it may proceed.
func (l *Limiter) Allow(client string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.seen == nil {
		l.seen = make(map[string][]time.Time)
	}
	cutoff := now.Add(-l.Window)
	recent := l.seen[client][:0]
	for _, at := range l.seen[client] {
		if at.After(cutoff) {
			recent = append(recent, at)
		}
	}
	if len(recent) >= l.Burst {
		l.seen[client] = recent
		return false
	}
	l.seen[client] = append(recent, now)
	return true
}
