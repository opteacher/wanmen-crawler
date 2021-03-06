Promise = require("bluebird")
const fs = require("fs")
const fsPromises = fs.promises
const url = require("url")
const puppeteer = require("puppeteer")
const m3u8ToMp4 = require("node-m3u8-to-mp4")
const config = require("./config")

let params = process.argv.slice(2)
for (let i = 0; i < params.length; i++) {
	switch (params[i].toLowerCase()) {
	case "-i":
		if (i === params.length - 1) {
			console.log("请指定要下载的课程")
			process.exit(-1)
		} else {
			if (!config.identified_courses) {
				config.identified_courses = []
			}
			config.identified_courses.push(params[i + 1])
		}
		break
	}
}

class Puppeteer {

	async start() {
		this.browser = await puppeteer.launch({
			executablePath: config.chromium,
			headless: true
		})
		this.page = await this.browser.newPage()
		this.page.setDefaultNavigationTimeout(600000)
	}

	/***
	 * 关闭浏览器
	 * @returns {Promise<*>}
	 */
	async close() {
		return await this.browser.close()
	}

	/***
	 * 登陆
	 * @returns {Promise<void>}
	 */
	async signin() {
		console.log(`跳转${config.pages.home}……`)
		await this.page.goto(config.pages.home, {
			waitUntil: "networkidle2" // 等待网络状态为空闲的时候才继续执行
		})

		// 点击登陆
		console.log("点击登陆")
		let signinBtn = await this.page.waitForXPath("//a[starts-with(@class,'header__inlist-sign-in--')]")
		await signinBtn.tap()

		// 点击并输入用户名和密码
		console.log("输入用户名……")
		let signinForm = await this.page.waitForXPath("//div[starts-with(@class,'authentication__form--')]")
		let account = await signinForm.$("input[name='account']")
		await account.tap()
		await account.type(config.log_info.account)

		console.log("输入密码……")
		let password = await signinForm.$("input[name='password']")
		await password.tap()
		await password.type(config.log_info.password)

		// 点击登陆
		console.log("提交登陆")
		let signinBtnContainer = await this.page.waitForXPath("//div[starts-with(@class,'sign-in-form__submit-button--')]")
		let loginBtn = await signinBtnContainer.$("button")
		await loginBtn.click()

		console.log("登陆成功！")
		await this.page.waitFor(2000)
	}

	/***
	 * 列出购买的课程
	 * @returns {Promise<*>}
	 */
	async listCourses() {
		console.log(`跳转${config.pages.paid}……`)
		await this.page.goto(config.pages.paid, {
			waitUntil: "networkidle2"
		})

		console.log("等待读取课程列表……")
		let courses = []
		let courseLstContainer = await this.page.waitForXPath("//div[starts-with(@class,'account__content--')]//ul")
		let index = 1
		for (let course of await courseLstContainer.$$("li")) {
			console.log(`收集第${index}门课程路径`)
			courses.push(await course.$eval("a", a => {
				return {
					title: a.innerText.split("\n")[0],
					href: a.href
				}
			}))
			index++
		}
		if (config.identified_courses.length !== 0) {
			let cssTmp = []
			console.log("指定下载：[")
			for (let course of courses) {
				if (config.identified_courses.includes(course.title)) {
					console.log(`\t${course.title},`)
					cssTmp.push(course)
				}
			}
			console.log("]")
			courses = cssTmp
		}

		console.log("课程读取完毕")
		await this.page.waitFor(2000)
		return Promise.resolve(courses)
	}

	/***
	 * 下载所有讲课视频
	 * @param course
	 * @returns {Promise<void>}
	 */
	async downloadCourse(course) {
		// 创建课程文件夹
		let csPath = `output/${course.title}`
		console.log(`创建课程文件夹：${csPath}`)
		try {
			await fsPromises.access(csPath, fs.constants.F_OK)
		} catch (e) {
			await fsPromises.mkdir(csPath)
		}

		// 初次跳转到课程视频页面
		console.log(`跳转：${course.href}`)
		await this.page.goto(course.href, {
			waitUntil: "networkidle2"
		})

		// 过滤出所有讲课记录链接
		console.log("扫描讲课列表")
		await this.page.waitForXPath("//li[starts-with(@class,'components__child-item--')]")
		for (let lecture of await this.page.$x("//div[contains(@class,'components__child-index-name--')]")) {
			// 讲课视频文件的名字
			let lName = await (await lecture.getProperty("title")).jsonValue()
			// 检查名字中是否有文件夹分隔符
			lName = lName.replace("/", ",")
			let chapter = await lecture.$$eval("span", spans => {
				for (let span of spans) {
					if (span.className && span.className.startsWith("components__index--")) {
						return span.innerHTML
					}
				}
			})
			lName = `${chapter} ${lName}`

			// 检查视频是否已经存在
			let outputPath = `output/${course.title}/${lName}.mp4`
			try {
				let mp4Stat = await fsPromises.stat(outputPath)
				// mp4文件大于26M，则判定已经存在，不需要下载
				if (mp4Stat.size > 26320304) {
					console.log(`已经存在，跳过下载${outputPath}`)
					continue
				}
			} catch (e) {
			}

			// 依次点击
			console.log(`将要跳转到：${lName}`)
			do {
				await lecture.click()
			} while (!(await this.downloadVideo(outputPath)))
		}
	}

	/***
	 * 下载讲课视频
	 * @param outputPath
	 * @returns {Promise<boolean>}
	 */
	async downloadVideo(outputPath) {
		// 收集页面加载过程中的m3u8文件请求
		let m3u8List = []
		this.page.on("response", response => {
			if (response.status() !== 200) {
				return
			}
			let reqUrl = response.url()
			// console.log(`响应来自：${reqUrl}`)
			if (url.parse(reqUrl).pathname.endsWith(".m3u8")) {
				m3u8List.push(reqUrl)
			}
		})
		await this.page.waitFor(10000)

		// m3u8转成mp4
		console.log(m3u8List)
		for (let m3u8Url of m3u8List) {
			try {
				await m3u8ToMp4(m3u8Url, outputPath)
				return true
			} catch (e) {
				console.error(e)
			}
		}
		return false
	}
}

(async () => {
	let ppr = new Puppeteer()
	await ppr.start()
	await ppr.signin()
	for (let csUrl of await ppr.listCourses()) {
		await ppr.downloadCourse(csUrl)
	}
	return ppr.close()
})()