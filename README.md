

# [konkr.io](https://www.konkr.io/) website

A basic blog/website for my HTML5 strategy game passion project.
Built with jekyll, served on Netlify.

## How to run

```
bundle exec jekyll serve
```

## Community fork

Play the static community edition at
[GitHub Pages](https://owlofmoistness.github.io/konkr_web/).
Maps and metadata are maintained in [community maps](community%20maps/README.md).
The original release files remain unchanged.

The optional anonymous voting service runs separately on a home Docker server.
After cloning, copy `community/deploy/voting/.env.example` to
`community/deploy/voting/.env`, fill in the two random secrets and the dedicated
Cloudflare tunnel token, then run from the repository root:

```sh
docker compose up -d
```

Configure the tunnel hostname `konkr-community.hoothoot.dev` to HTTP
`voting:8080`. See the [voting setup and backup guide](community/deploy/voting/README.md)
and [deployment guide](community/deploy/README.md).
