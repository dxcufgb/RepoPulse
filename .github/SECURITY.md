# Security policy

Only the latest release is supported. Please report security problems privately through
**Security → Report a vulnerability** on this repository rather than in a public issue.
You should get a reply within a week.

RepoPulse keeps a GitHub token (if you add one) in its database and an admin account that controls the dashboard.
If you think a token has leaked (in a log, a response, a commit), revoke it on GitHub first and then report it.
A forgotten or exposed admin password is reset on the server with `python -m repopulse set-password`, which also
logs out every other session.
