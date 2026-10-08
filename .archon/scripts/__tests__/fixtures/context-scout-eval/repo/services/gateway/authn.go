package gateway

import (
	"errors"
	"strings"
	"time"
)

// Claims is the decoded body of an upstream identity assertion.
type Claims struct {
	Subject   string
	Audience  string
	Issuer    string
	NotBefore time.Time
	Expiry    time.Time
}

var (
	ErrWrongAudience = errors.New("assertion audience does not match this gateway")
	ErrUntrusted     = errors.New("assertion issuer is not trusted")
	ErrNotYetValid   = errors.New("assertion is not valid yet")
	ErrExpired       = errors.New("assertion has expired")
	ErrNoSubject     = errors.New("assertion names no subject")
)

// CheckClaims decides whether a caller's identity assertion may be honoured.
func CheckClaims(c Claims, audience string, trusted []string, now time.Time) error {
	if strings.TrimSpace(c.Subject) == "" {
		return ErrNoSubject
	}
	if c.Audience != audience {
		return ErrWrongAudience
	}
	known := false
	for _, issuer := range trusted {
		if issuer == c.Issuer {
			known = true
			break
		}
	}
	if !known {
		return ErrUntrusted
	}
	if now.Before(c.NotBefore) {
		return ErrNotYetValid
	}
	if !now.Before(c.Expiry) {
		return ErrExpired
	}
	return nil
}
