The goal of this project has shifted significantly from the original scope.

We first began with the idea of building an exit node on a Raspberry Pi- a vpn of sorts. The issue with this original plan was, it was simply too basic. This plan then proceded to evolve:

VPN --> Mesh w/ single exit node --> Mesh w/ single exit node and gui --> Mesh w/ configurable exit nodes and gui --> Island internet.

The read me, has never actually been updated. The reason why, is because I simply never thought about it. Because of this, artifacts are in documented pull requests mainly.
  -Git documentation is a growing skill for me.

Anyways, the most recent scope change has been the delegation of an island internet. The issue here, of course, is that there's no longer a need for an ingress/egress point. The lack of this point means that many things, like the masquerade table, forwarding table, dns resolution. It's all somewhat gone. In fact, I have to rip much of the completed artifacts out of main.

Speaking of main, there are now three main branches. 1 for polaris, 1 for vega, and 1 for uniform development. Each node needs its own stuff, so specialty branches made the most sense for version control.

I need to update the scope files still.
