CONTEXT FOR CLAUDE CODE (GUI and APP)
I want Claude Code to rebuild the skeleton for the GUI and app. I need to take the ideas and drafts from this document and write out a context file to transfer over to Claude:
Take the original app and gui files and shift them to an archive branch in GitHub. 
After doing this, create a new branch off of main and delete the files.
A new GUI and App will be built with a different backend. THE LANGUAGE IS C:
The end user App will primarily consist of the following:
1.	A singular file which relies on mutual friending to authenticate and authorize permissions between node interactions.
a.	Friending is a token deal: one gives, and the other accepts. After this both can write files to the other node. Without a token interaction, there can be no permission exchange. 
2.	The friends can send messages between one another, and write/download files. 
3.	The app will allow for users to see if the island internet is currently gated (island mode) or not (internet access). 
4.	The home will allow users to see local fail2ban entries, active friend requests, and the wg connectivity status. 
The admin app can:
1.	Accessed by add /admin to the URL
2.	Manage friendships. 
a.	The admin can delete friendships, but cannot force friendships (security)
3.	The admin can initiate a text prompt to send to a local LLM to allow internet connectivity. This will be achieved via keyword at the beginning of a sentence. 
a.	Key work is called a canary. 
b.	Key word should be signed and sealed cryptographically
4.	The two backends should be very similar, and should be seamless. 
BUILD A SKELETON FOR IMPLEMENTATION
CLAUDE CODE CONTEXT FOR ARCHITECTURE
The new scope of the project is a gated island internet.
Gate will open dependent on a local LLM, probably Llama
The mesh is peer-to-peer, which is protected via the friending mechanism in the GUI. 
The new mesh is going to interact seamlessly, there’s no more hub redirects. 
