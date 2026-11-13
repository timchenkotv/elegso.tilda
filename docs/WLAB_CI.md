# WLab CI

GitHub Actions for `timchenkotv/elegso.tilda` run on the repository-scoped
VM780 `wlab-ci` runner with label `elegso-site-ci`. Because the repository is
public, the workflow is triggered only by pushes to `main` or trusted
`codex/**` branches and by an explicit manual dispatch. Fork pull requests do
not receive a self-hosted job.

The job runs the existing offline Node and Python regression suites. It has no
Docker, sudo, SSH login, production credentials or RFC1918 network access and
does not push to the VM deployment remote. A green run is not production
authorization.
