[x] if it is from xiaohongshu, with one or multiple pictures, keep those pictures under a folder with the same name of the md file.
[x] after add this extension to chrome, it shows Create Your Telegram Bot workflow. After I updated it, and the extension icon in the menu bar shows a block badge. If I click the icon, it ask me to do the setup again. After that, it will work. fix it.
[ ] add a new function, in chrome, if i open, and paste a url, it will save it as md file. so in the ui, it has a area, saying paste here, border is dashed, the user can right click and paste, or use keyboard shortcut to paste, without confirm button, it will do the save action.
![alt text](image.png)
[ ] add a funtion, 做右键菜单 Save to Markdown Vault
需要加 contextMenus 权限（你现在还没有：manifest.json (line 6)），然后在 background.js 里监听菜单点击并调用现有 save_url 流程。 so, 右键菜单 Save to Markdown Vault will be an option, and user can turn on/ off in the setting. 

[ ] 如果发的是图片，命名，date+name.jpg
[ ] copy paste url, bug, it will save twice.
[ ] 显示last pull和next pull的时间
