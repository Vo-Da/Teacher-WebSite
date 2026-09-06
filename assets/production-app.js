(function () {
  "use strict";

  const config = window.TEACHER_PORTAL_CONFIG || {};
  const root = document.getElementById("appRoot");
  const state = {
    client: null,
    session: null,
    profile: null,
    membership: null,
    school: null,
    activeRole: null,
    canBootstrapSchool: false,
    data: emptyData(),
    activeView: "overview",
    selectedDate: dateInTimezone(new Date(), "Europe/Kyiv"),
    calendarOffset: 0,
    selectedLessonId: null,
    selectedStudentId: null,
    recording: null,
    notice: null,
    loading: false
  };

  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("change", handleChange);

  void initialize();

  function emptyData() {
    return {
      profiles: [],
      memberships: [],
      requests: [],
      subjects: [],
      teacherStudents: [],
      rates: [],
      lessons: [],
      lessonStudents: [],
      homework: [],
      homeworkStudents: [],
      submissions: [],
      attachments: [],
      studentInternalProfiles: [],
      studentInternalNotes: [],
      ledger: []
    };
  }

  async function initialize() {
    if (!isConfigured()) {
      renderSetup();
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      renderFatal("Не вдалося завантажити Supabase SDK. Перевір інтернет-з’єднання та онови сторінку.");
      return;
    }
    state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data } = await state.client.auth.getSession();
    state.session = data.session;
    state.client.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      void refreshContext();
    });
    await refreshContext();
  }

  function isConfigured() {
    return typeof config.supabaseUrl === "string"
      && config.supabaseUrl.startsWith("https://")
      && typeof config.supabaseAnonKey === "string"
      && config.supabaseAnonKey.length > 20;
  }

  async function refreshContext() {
    state.profile = null;
    state.membership = null;
    state.school = null;
    state.canBootstrapSchool = false;
    state.data = emptyData();
    state.selectedLessonId = null;
    state.selectedStudentId = null;

    if (!state.session) {
      state.activeRole = null;
      renderAuth();
      return;
    }

    setLoading(true);
    try {
      const userId = state.session.user.id;
      const profileResult = await state.client.from("profiles").select("*").eq("id", userId).maybeSingle();
      if (profileResult.error && profileResult.error.code !== "PGRST116") throw profileResult.error;
      state.profile = profileResult.data || null;

      const membershipResult = await state.client
        .from("school_memberships")
        .select("id, school_id, roles, status, schools(id, name, currency, timezone)")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      if (membershipResult.error) throw membershipResult.error;
      state.membership = (membershipResult.data || []).find((item) => item.status === "active") || null;
      if (state.membership && !membershipRoles().includes(state.activeRole)) state.activeRole = preferredRole();

      if (!state.membership) {
        const [requestResult, bootstrapResult] = await Promise.all([
          state.client
            .from("registration_requests")
            .select("id, requested_role, status, created_at")
            .eq("user_id", userId)
            .maybeSingle(),
          state.client.rpc("can_bootstrap_school")
        ]);
        if (requestResult.error && requestResult.error.code !== "PGRST116") throw requestResult.error;
        if (bootstrapResult.error) throw bootstrapResult.error;
        state.canBootstrapSchool = bootstrapResult.data === true;
        if (!requestResult.data && !state.canBootstrapSchool) {
          const registration = storedRegistrationDetails();
          if (registration) {
            const { error: requestError } = await state.client.rpc("request_membership", {
              p_full_name: registration.fullName,
              p_requested_role: registration.requestedRole
            });
            if (requestError) throw requestError;
            await refreshContext();
            return;
          }
        }
        renderOnboarding(requestResult.data || null);
        return;
      }

      state.school = state.membership.schools || { id: state.membership.school_id, name: config.schoolName || "Школа", currency: "UAH", timezone: "Europe/Kyiv" };
      await loadDashboardData();
      renderDashboard();
    } catch (error) {
      renderFatal(`Не вдалося завантажити дані: ${friendlyError(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboardData() {
    const schoolId = state.membership.school_id;
    const canAdminister = hasRole("admin");
    const canManageStudentContext = state.activeRole === "admin" || state.activeRole === "teacher";
    const [subjects, relations, lessons, homework, profiles, memberships, studentInternalProfiles, studentInternalNotes] = await Promise.all([
      selectRows("subjects", (q) => q.eq("school_id", schoolId).order("name")),
      selectRows("teacher_students", (q) => q.eq("school_id", schoolId).eq("is_active", true)),
      selectRows("lessons", (q) => q.eq("school_id", schoolId).order("starts_at")),
      selectRows("homework", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false })),
      selectRows("profiles", (q) => q.order("full_name")),
      canAdminister ? selectRows("school_memberships", (q) => q.eq("school_id", schoolId)) : Promise.resolve([]),
      canManageStudentContext ? selectRows("student_internal_profiles", (q) => q.eq("school_id", schoolId)) : Promise.resolve([]),
      canManageStudentContext ? selectRows("student_internal_notes", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false })) : Promise.resolve([])
    ]);

    state.data.subjects = subjects;
    state.data.teacherStudents = relations;
    state.data.lessons = lessons;
    state.data.homework = homework;
    state.data.profiles = profiles;
    state.data.memberships = memberships;
    state.data.studentInternalProfiles = studentInternalProfiles;
    state.data.studentInternalNotes = studentInternalNotes;

    const lessonIds = lessons.map((item) => item.id);
    const homeworkIds = homework.map((item) => item.id);
    state.data.lessonStudents = await selectRowsIn("lesson_students", "lesson_id", lessonIds);
    state.data.homeworkStudents = await selectRowsIn("homework_students", "homework_id", homeworkIds);
    state.data.submissions = await selectRowsIn("homework_submissions", "homework_student_id", state.data.homeworkStudents.map((item) => item.id));
    state.data.attachments = await selectRows("file_attachments", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false }));

    if (canAdminister) {
      const [requests, rates, ledger] = await Promise.all([
        selectRows("registration_requests", (q) => q.eq("status", "pending").order("created_at")),
        selectRows("student_rates", (q) => q.eq("school_id", schoolId).order("active_from", { ascending: false })),
        selectRows("wallet_ledger", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false }))
      ]);
      state.data.requests = requests;
      state.data.rates = rates;
      state.data.ledger = ledger;
    }
  }

  async function selectRows(table, modifier) {
    let query = state.client.from(table).select("*");
    if (modifier) query = modifier(query);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function selectRowsIn(table, column, ids) {
    if (!ids.length) return [];
    return selectRows(table, (q) => q.in(column, ids));
  }

  function renderSetup() {
    root.innerHTML = shell(`
      <section class="auth-shell">
        <div class="auth-card wide-card">
          <div class="brand">${brandMark()}<div><div class="brand-title">Teacher Portal</div><div class="brand-sub">Production setup</div></div></div>
          <h1>Потрібне підключення до Supabase</h1>
          <p class="muted">Вкажи URL і publishable/anon key нового staging-проєкту у файлі <code>assets/config.js</code>. Не додавай у браузер <code>service_role</code> key.</p>
          <div class="filebox"><strong>Порядок запуску:</strong><br>1. Запусти <code>supabase/production_schema.sql</code> у SQL Editor.<br>2. Вкажи конфігурацію.<br>3. Створи перший admin-акаунт через форму нижче.</div>
        </div>
      </section>
    `);
  }

  function renderAuth() {
    root.innerHTML = shell(`
      <section class="auth-shell">
        <div class="auth-card wide-card">
          <div class="brand">${brandMark()}<div><div class="brand-title">${escape(config.schoolName || "Teacher Portal")}</div><div class="brand-sub">Кабінет школи</div></div></div>
          ${renderNotice()}
          <div class="auth-columns">
            <form id="loginForm" class="stack card plain-card">
              <div class="auth-login-emblem">${brandMark("auth-login-mark")}</div>
              <h2>Вхід</h2>
              <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
              <div class="field"><label>Пароль</label><input name="password" type="password" required autocomplete="current-password" /></div>
              <button class="btn primary" type="submit">Увійти</button>
            </form>
            <form id="registerForm" class="stack card plain-card">
              <h2>Реєстрація</h2>
              <div class="field"><label>Ім’я та прізвище</label><input name="fullName" required /></div>
              <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
              <div class="field"><label>Пароль</label><input name="password" type="password" minlength="8" required autocomplete="new-password" /></div>
              <div class="field"><label>Я реєструюся як</label><select name="requestedRole"><option value="student">Учень</option><option value="teacher">Викладач</option></select></div>
              <button class="btn secondary" type="submit">Створити заявку</button>
              <div class="meta">Підтвердь email, і заявка з цими даними автоматично надійде адміністратору.</div>
            </form>
          </div>
        </div>
      </section>
    `);
  }

  function renderOnboarding(request) {
    const userName = state.session.user.email || "";
    const registration = storedRegistrationDetails();
    root.innerHTML = shell(`
      <section class="auth-shell">
        <div class="auth-card wide-card">
          <div class="brand">${brandMark()}<div><div class="brand-title">Teacher Portal</div><div class="brand-sub">${escape(userName)}</div></div></div>
          ${renderNotice()}
          ${request ? `
            <h1>Заявка очікує підтвердження</h1>
            <p class="muted">Адміністратор має підтвердити роль: <strong>${request.requested_role === "teacher" ? "викладач" : "учень"}</strong>.</p>
          ` : `
            <div class="auth-columns ${state.canBootstrapSchool ? "" : "single-column"}">
              ${state.canBootstrapSchool ? `<form id="bootstrapSchoolForm" class="stack card plain-card">
                <h2>Створити першу школу</h2>
                <p class="muted">Це виконує лише перший власник нового Supabase-проєкту.</p>
                <div class="field"><label>Назва школи</label><input name="schoolName" value="${escapeAttr(config.schoolName || "Моя школа")}" required /></div>
                <div class="field"><label>Ім’я адміністратора</label><input name="fullName" value="${escapeAttr(state.profile?.full_name || registration?.fullName || "")}" required /></div>
                <button class="btn secondary" type="submit">Створити школу та admin-доступ</button>
              </form>` : `<div class="card plain-card"><h2>Не вдалося знайти дані заявки</h2><p class="muted">Увійди через сторінку реєстрації ще раз або звернися до адміністратора. Для нових акаунтів повторно заповнювати форму не потрібно.</p></div>`}
            </div>
          `}
          <button class="btn small secondary" type="button" data-action="logout">Вийти</button>
        </div>
      </section>
    `);
  }

  function renderFatal(message) {
    root.innerHTML = shell(`<section class="auth-shell"><div class="auth-card"><h1>Потрібна увага</h1><div class="msg error">${escape(message)}</div></div></section>`);
  }

  function brandMark(variant = "") {
    return `<div class="brand-mark horse-mark ${variant}" role="img" aria-label="Емблема школи: кінь у стрибку та відкрита книга"><img src="./assets/academy-crest.png" alt="" /></div>`;
  }

  function shell(content) {
    return `<main class="production-app">${content}</main>`;
  }

  async function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    try {
      if (action === "logout") {
        await state.client.auth.signOut();
        return;
      }
      if (action === "set-view") {
        state.activeView = target.dataset.view || "overview";
        renderDashboard();
        return;
      }
      if (action === "set-role") {
        const role = target.dataset.role;
        if (!hasRole(role)) return;
        state.activeRole = role;
        state.activeView = defaultViewForRole(role);
        renderDashboard();
        return;
      }
      if (action === "calendar-prev") {
        state.calendarOffset -= 1;
        renderDashboard();
        return;
      }
      if (action === "calendar-next") {
        state.calendarOffset += 1;
        renderDashboard();
        return;
      }
      if (action === "calendar-today") {
        state.calendarOffset = 0;
        state.selectedDate = isoDate(new Date());
        state.selectedLessonId = null;
        renderDashboard();
        return;
      }
      if (action === "select-date") {
        state.selectedDate = target.dataset.date;
        state.selectedLessonId = null;
        renderDashboard();
        return;
      }
      if (action === "select-lesson") {
        state.selectedLessonId = target.dataset.lessonId || null;
        renderDashboard();
        return;
      }
      if (action === "open-student-card") {
        state.selectedStudentId = target.dataset.studentId || null;
        renderDashboard();
        return;
      }
      if (action === "close-student-card") {
        state.selectedStudentId = null;
        renderDashboard();
        return;
      }
      if (action === "start-media-recording") {
        await startMediaRecording(target);
        return;
      }
      if (action === "stop-media-recording") {
        stopMediaRecording(target.dataset.captureId);
        return;
      }
      if (action === "clear-media-recording") {
        clearMediaRecording(target);
        return;
      }
      if (action === "reset-student-statistics") {
        const statistics = target.closest(".student-statistics");
        if (!statistics) return;
        statistics.querySelectorAll("[data-student-stat-range]").forEach((input) => { input.value = ""; });
        refreshStudentStatistics(statistics);
        return;
      }
      if (action === "approve-request") {
        await approveRequest(target.dataset.requestId);
        return;
      }
      if (action === "remove-assignment") {
        if (!confirm("Прибрати цього учня зі списку викладача?")) return;
        const { error } = await state.client.from("teacher_students").delete().eq("id", target.dataset.relationId);
        if (error) throw error;
        state.notice = success("Зв’язок викладача й учня прибрано.");
        await refreshContext();
        return;
      }
      if (action === "suspend-user" || action === "activate-user") {
        await manageAdminUser({ action: action === "suspend-user" ? "suspend" : "activate", userId: target.dataset.userId });
        return;
      }
      if (action === "delete-user") {
        const userName = target.dataset.userName || "цього користувача";
        const message = `Ви впевнені, що хочете остаточно видалити ${userName}?\n\nБуде безповоротно видалено акаунт, його уроки, домашні завдання, файли та пов’язані фінансові записи. Цю дію неможливо скасувати.\n\nЩоб лише закрити доступ і зберегти історію, натисніть «Скасувати» та оберіть «Призупинити».`;
        if (!confirm(message)) return;
        await manageAdminUser({ action: "delete", userId: target.dataset.userId });
        return;
      }
      if (action === "download-file") {
        await downloadAttachment(target.dataset.fileId);
        return;
      }
      if (action === "mark-homework-reviewed") {
        await updateHomeworkStudent(target.dataset.homeworkStudentId, { status: "reviewed", reviewed_at: new Date().toISOString() });
        return;
      }
      if (action === "delete-lesson") {
        if (!confirm("Видалити це заняття?")) return;
        const { error } = await state.client.from("lessons").delete().eq("id", target.dataset.lessonId);
        if (error) throw error;
        state.notice = success("Заняття видалено.");
        await refreshContext();
      }
    } catch (error) {
      state.notice = failure(friendlyError(error));
      renderCurrent();
    }
  }

  function handleChange(event) {
    const input = event.target;
    if (input.matches?.("[data-student-stat-range]")) {
      const statistics = input.closest(".student-statistics");
      refreshStudentStatistics(statistics);
      return;
    }
    if (input.name !== "startsAt" || input.form?.id !== "createLessonForm" || !input.value) return;
    const endInput = input.form.elements.endsAt;
    const start = new Date(input.value);
    if (!endInput || Number.isNaN(start.getTime())) return;
    start.setHours(start.getHours() + 1);
    endInput.value = dateTimeInputValue(start);
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!form.id) return;
    event.preventDefault();
    try {
      if (form.id === "loginForm") await login(form);
      if (form.id === "registerForm") await register(form);
      if (form.id === "requestMembershipForm") await requestMembership(form);
      if (form.id === "bootstrapSchoolForm") await bootstrapSchool(form);
      if (form.id === "createSubjectForm") await createSubject(form);
      if (form.id === "assignTeacherStudentForm") await assignTeacherStudent(form);
      if (form.id === "createRateForm") await createRate(form);
      if (form.id === "createLessonForm") await createLesson(form);
      if (form.id === "lessonCardForm") await saveLessonCard(form);
      if (form.id === "createHomeworkForm") await createHomework(form);
      if (form.id === "recordPaymentForm") await recordPayment(form);
      if (form.id === "submitHomeworkForm") await submitHomework(form);
      if (form.id === "feedbackForm") await sendFeedback(form);
      if (form.id === "studentInternalCardForm") await saveStudentInternalCard(form);
      if (form.id === "adminCreateUserForm") await createAdminUser(form);
      if (form.id === "changeUserRolesForm") await changeUserRoles(form);
    } catch (error) {
      state.notice = failure(friendlyError(error));
      renderCurrent();
    }
  }

  async function login(form) {
    const { error } = await state.client.auth.signInWithPassword({
      email: value(form, "email"),
      password: value(form, "password")
    });
    if (error) throw error;
    state.notice = success("Вхід виконано.");
  }

  async function register(form) {
    const email = value(form, "email");
    const password = value(form, "password");
    const fullName = value(form, "fullName");
    const requestedRole = value(form, "requestedRole");
    const { data, error } = await state.client.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, requested_role: requestedRole },
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`
      }
    });
    if (error) throw error;
    if (data.session) {
      const { error: requestError } = await state.client.rpc("request_membership", { p_full_name: fullName, p_requested_role: requestedRole });
      if (requestError) throw requestError;
      state.notice = success("Заявку створено. Очікуй підтвердження адміністратора.");
    } else {
      state.notice = success("Перевір email і підтверди адресу. Після переходу за посиланням заявка з уже введеними даними надійде адміністратору автоматично.");
      renderAuth();
    }
  }

  async function requestMembership(form) {
    const { error } = await state.client.rpc("request_membership", {
      p_full_name: value(form, "fullName"),
      p_requested_role: value(form, "requestedRole")
    });
    if (error) throw error;
    state.notice = success("Заявку надіслано адміністратору.");
    await refreshContext();
  }

  async function bootstrapSchool(form) {
    const { error } = await state.client.rpc("bootstrap_school", {
      p_school_name: value(form, "schoolName"),
      p_full_name: value(form, "fullName")
    });
    if (error) throw error;
    state.notice = success("Школу створено. Ти маєш admin-доступ.");
    await refreshContext();
  }

  async function approveRequest(requestId) {
    const { error } = await state.client.rpc("approve_registration", {
      p_request_id: requestId,
      p_school_id: state.school.id
    });
    if (error) throw error;
    state.notice = success("Заявку підтверджено.");
    await refreshContext();
  }

  async function createSubject(form) {
    const payload = {
      school_id: state.school.id,
      name: value(form, "name"),
      color: value(form, "color") || "#0f766e",
      default_duration_minutes: Number(value(form, "duration")) || 60
    };
    const { error } = await state.client.from("subjects").insert(payload);
    if (error) throw error;
    state.notice = success("Предмет додано.");
    await refreshContext();
  }

  async function assignTeacherStudent(form) {
    const { error } = await state.client.from("teacher_students").upsert({
      school_id: state.school.id,
      teacher_id: value(form, "teacherId"),
      student_id: value(form, "studentId"),
      is_active: true
    }, { onConflict: "school_id,teacher_id,student_id" });
    if (error) throw error;
    state.notice = success("Учня прив’язано до викладача.");
    await refreshContext();
  }

  async function createRate(form) {
    const price = wholeUah(value(form, "lessonPrice"));
    const payout = wholeUah(value(form, "teacherPayout"));
    const { error } = await state.client.from("student_rates").insert({
      school_id: state.school.id,
      student_id: value(form, "studentId"),
      teacher_id: value(form, "teacherId") || null,
      subject_id: value(form, "subjectId") || null,
      lesson_price_uah: price,
      teacher_payout_uah: payout,
      active_from: value(form, "activeFrom") || isoDate(new Date())
    });
    if (error) throw error;
    state.notice = success("Тариф збережено.");
    await refreshContext();
  }

  async function createLesson(form) {
    const studentIds = values(form, "studentIds");
    const subjectId = value(form, "subjectId");
    const typedTitle = value(form, "title");
    const startsAt = new Date(value(form, "startsAt"));
    const endsAt = new Date(value(form, "endsAt"));
    const { data, error } = await state.client.rpc("create_lesson", {
      p_school_id: state.school.id,
      p_subject_id: subjectId,
      p_title: typedTitle.length >= 2 ? typedTitle : `Заняття: ${subjectName(subjectId)}`,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_student_ids: studentIds,
      p_meeting_url: value(form, "meetingUrl"),
      p_location_text: value(form, "location")
    });
    if (error) throw error;
    state.selectedLessonId = data;
    state.selectedDate = isoDate(startsAt);
    state.notice = success("Заняття створено. Ціну для кожного учня зафіксовано.");
    await refreshContext();
  }

  async function saveLessonCard(form) {
    const lessonId = value(form, "lessonId");
    const homeworkTitle = value(form, "homeworkTitle");
    const homeworkDescription = value(form, "homeworkDescription");
    const homeworkDeadline = value(form, "homeworkDeadline");
    const hasHomeworkFiles = hasSelectedFiles(form, '[name="homeworkFiles"], [data-recorded-media]');
    const hasHomeworkDetails = homeworkTitle || homeworkDescription || homeworkDeadline || hasHomeworkFiles;
    if (hasHomeworkDetails && !homeworkTitle) throw new Error("Щоб опублікувати домашнє, додай його назву.");

    const { error } = await state.client.rpc("set_lesson_status", {
      p_lesson_id: lessonId,
      p_status: value(form, "status"),
      p_note: value(form, "teacherNote")
    });
    if (error) throw error;
    if (hasHomeworkDetails) {
      const { data, error: homeworkError } = await state.client.rpc("create_homework", {
        p_school_id: state.school.id,
        p_lesson_id: lessonId,
        p_title: homeworkTitle,
        p_description: homeworkDescription,
        p_deadline_at: homeworkDeadline ? new Date(homeworkDeadline).toISOString() : null,
        p_student_ids: lessonStudents(lessonId).map((row) => row.student_id)
      });
      if (homeworkError) throw homeworkError;
      await uploadInputFiles(form, { homework_id: data }, '[name="homeworkFiles"], [data-recorded-media]');
    }
    await uploadInputFiles(form, { lesson_id: lessonId }, '[name="lessonFiles"]');
    state.notice = success(hasHomeworkDetails ? "Картку заняття й домашнє збережено." : "Картку заняття збережено. За потреби фінансовий запис створено автоматично.");
    await refreshContext();
  }

  async function createHomework(form) {
    const lessonId = value(form, "lessonId") || null;
    const selectedLesson = lessonId ? lessonById(lessonId) : null;
    const studentIds = selectedLesson ? lessonStudents(selectedLesson.id).map((row) => row.student_id) : values(form, "studentIds");
    const { data, error } = await state.client.rpc("create_homework", {
      p_school_id: state.school.id,
      p_lesson_id: lessonId,
      p_title: value(form, "title"),
      p_description: value(form, "description"),
      p_deadline_at: value(form, "deadline") ? new Date(value(form, "deadline")).toISOString() : null,
      p_student_ids: studentIds
    });
    if (error) throw error;
    await uploadInputFiles(form, { homework_id: data });
    state.notice = success("Домашнє завдання опубліковано.");
    await refreshContext();
  }

  async function recordPayment(form) {
    const amount = wholeUah(value(form, "amount"));
    if (amount <= 0) throw new Error("Сума оплати має бути більшою за нуль.");
    const { error } = await state.client.from("wallet_ledger").insert({
      school_id: state.school.id,
      student_id: value(form, "studentId"),
      teacher_id: null,
      kind: "payment",
      amount_uah: amount,
      teacher_payout_uah: 0,
      note: value(form, "note"),
      created_by: state.session.user.id
    });
    if (error) throw error;
    state.notice = success("Оплату внесено у фінансовий журнал.");
    await refreshContext();
  }

  async function submitHomework(form) {
    const homeworkStudentId = value(form, "homeworkStudentId");
    const { data, error } = await state.client.rpc("submit_homework", {
      p_homework_student_id: homeworkStudentId,
      p_body: value(form, "body")
    });
    if (error) throw error;
    await uploadInputFiles(form, { submission_id: data });
    state.notice = success("Відповідь на домашнє завдання надіслано.");
    await refreshContext();
  }

  async function sendFeedback(form) {
    const homeworkStudentId = value(form, "homeworkStudentId");
    const status = value(form, "status");
    const { error } = await state.client.from("homework_students").update({
      status,
      teacher_comment: value(form, "comment"),
      grade: value(form, "grade") || null,
      reviewed_at: new Date().toISOString()
    }).eq("id", homeworkStudentId);
    if (error) throw error;
    await uploadInputFiles(form, { homework_student_id: homeworkStudentId });
    state.notice = success("Зворотний зв’язок збережено.");
    await refreshContext();
  }

  async function saveStudentInternalCard(form) {
    const studentId = value(form, "studentId");
    if (!studentId) throw new Error("Обери учня для картки учня.");
    const { error } = await state.client.from("student_internal_profiles").upsert({
      school_id: state.school.id,
      student_id: studentId,
      goal: value(form, "goal"),
      starting_level: value(form, "startingLevel"),
      current_level: value(form, "currentLevel"),
      updated_by: state.session.user.id,
      updated_at: new Date().toISOString()
    }, { onConflict: "school_id,student_id" });
    if (error) throw error;
    const body = value(form, "body");
    if (body) {
      const { error: noteError } = await state.client.from("student_internal_notes").insert({
        school_id: state.school.id,
        student_id: studentId,
        author_id: state.session.user.id,
        body
      });
      if (noteError) throw noteError;
    }
    state.notice = success(body ? "Картку учня та внутрішню нотатку збережено." : "Картку учня збережено. Учень її не бачить.");
    await refreshContext();
  }

  async function createAdminUser(form) {
    const password = value(form, "password");
    if (password.length < 8) throw new Error("Пароль має містити щонайменше 8 символів.");
    const roles = values(form, "roles");
    if (!roles.length) throw new Error("Вибери хоча б одну роль для нового користувача.");
    await manageAdminUser({
      action: "create",
      fullName: value(form, "fullName"),
      email: value(form, "email"),
      password,
      roles
    });
  }

  async function changeUserRoles(form) {
    const roles = values(form, "roles");
    if (!roles.length) throw new Error("У користувача має залишитися хоча б одна роль.");
    await manageAdminUser({ action: "set_roles", userId: value(form, "userId"), roles });
  }

  async function manageAdminUser(payload) {
    const { data, error } = await state.client.functions.invoke("admin-users", {
      body: { ...payload, schoolId: state.school.id }
    });
    if (error) {
      let message = "";
      try {
        const response = error.context;
        const body = response && typeof response.json === "function" ? await response.json() : null;
        message = typeof body?.error === "string" ? body.error : "";
      } catch (_) {
        // The generic error remains a safe fallback when the server gives no JSON body.
      }
      if (message) throw new Error(message);
      throw error;
    }
    if (data?.error) throw new Error(data.error);
    state.notice = success(data?.message || "Зміни доступу збережено.");
    await refreshContext();
  }

  function renderDashboard() {
    const role = state.activeRole || preferredRole();
    const navigation = navigationForRole(role);
    if (!navigation.some(([view]) => view === state.activeView)) state.activeView = navigation[0][0];

    root.innerHTML = shell(`
      <section class="school-shell">
        <header class="school-header">
          <div class="container school-header-inner">
            <div class="brand">${brandMark()}<div><div class="brand-title">${escape(state.school.name)}</div><div class="brand-sub">${escape(modeTitle(role))} • ${escape(state.profile?.full_name || state.session.user.email)}</div></div></div>
            <div class="header-actions">${renderModeSwitcher(role)}<button type="button" class="btn small secondary" data-action="logout">Вийти</button></div>
          </div>
        </header>
        <div class="container school-layout">
          <aside class="school-nav">
            ${navigation.map(([view, label]) => `<button class="nav-item ${state.activeView === view ? "active" : ""}" type="button" data-action="set-view" data-view="${view}">${label}</button>`).join("")}
          </aside>
          <section class="school-content">
            ${renderNotice()}
            ${role === "admin" ? renderAdminView() : ""}
            ${role === "teacher" ? renderTeacherView() : ""}
            ${role === "student" ? renderStudentView() : ""}
          </section>
        </div>
      </section>
    `);
  }

  function navigationForRole(role) {
    return role === "admin"
      ? [["overview", "Огляд"], ["people", "Люди"], ["subjects", "Предмети і тарифи"], ["payments", "Оплати"], ["finance", "Фінанси"]]
      : role === "teacher"
        ? [["calendar", "Календар"], ["students", "Мої учні"], ["homework", "Домашні"]]
        : [["today", "Сьогодні"], ["calendar", "Календар"], ["homework", "Домашні"]];
  }

  function renderAdminView() {
    if (state.activeView === "overview") return renderAdminOverview();
    if (state.activeView === "people") return renderPeople();
    if (state.activeView === "subjects") return renderSubjectsAndRates();
    if (state.activeView === "payments") return renderAdminPayments();
    return renderFinance();
  }

  function renderAdminOverview() {
    const teachers = activeMembers("teacher");
    const students = activeMembers("student");
    const balances = walletBalances();
    const totalBalance = Object.values(balances).reduce((sum, item) => sum + item.balance, 0);
    const month = monthKey(new Date());
    const chargedThisMonth = state.data.ledger.filter((row) => row.kind === "lesson_charge" && row.created_at.startsWith(month) && row.status === "confirmed").reduce((sum, row) => sum + Math.abs(row.amount_uah), 0);
    return `
      <div class="page-heading"><div><p class="eyebrow">Адміністрування</p><h1>Огляд школи</h1><p class="muted">Ключові показники без зайвої бухгалтерії.</p></div></div>
      <div class="metric-grid">
        ${metricCard("Активні учні", students.length, "Наразі мають доступ")}
        ${metricCard("Активні викладачі", teachers.length, "Можна призначати учнів")}
        ${metricCard("Заявки", state.data.requests.length, "Очікують рішення")}
        ${metricCard("Баланс учнів", money(totalBalance), "Сумарний передплачений баланс")}
        ${metricCard("Списано цього місяця", money(chargedThisMonth), "Проведені та платні скасування")}
      </div>
      <div class="card"><h2>Найближчі заняття</h2>${renderLessonFeed(nextLessons(8))}</div>
    `;
  }

  function renderPeople() {
    const teachers = activeMembers("teacher");
    const students = activeMembers("student");
    return `
      <div class="page-heading"><div><p class="eyebrow">Доступ і групи</p><h1>Люди</h1><p class="muted">Адміністратор єдиний, хто призначає викладачів учням.</p></div></div>
      <div class="work-grid">
        <div class="card"><h2>Нові заявки</h2>
          <div class="list">${state.data.requests.length ? state.data.requests.map((item) => `
            <div class="item"><div class="item-head"><div><p class="item-title">${escape(item.full_name)}</p><div class="meta">${item.requested_role === "teacher" ? "Викладач" : "Учень"}</div></div><button class="btn small primary" data-action="approve-request" data-request-id="${item.id}">Підтвердити</button></div></div>
          `).join("") : empty("Нових заявок немає.")}</div>
        </div>
        <div class="card"><h2>Призначити викладача учню</h2>
          <form id="assignTeacherStudentForm" class="stack">
            ${selectField("teacherId", "Викладач", teachers, true)}
            ${selectField("studentId", "Учень", students, true)}
            <button class="btn primary" type="submit">Прив’язати</button>
          </form>
        </div>
      </div>
      <div class="work-grid">
        <div class="card"><h2>Створити акаунт</h2><p class="muted">Новий користувач отримає активний доступ одразу. Для однієї людини можна вибрати кілька ролей.</p><form id="adminCreateUserForm" class="stack"><div class="field"><label>Ім’я та прізвище</label><input name="fullName" required /></div><div class="field"><label>Email</label><input name="email" type="email" required /></div><div class="field"><label>Тимчасовий пароль</label><input name="password" type="password" minlength="8" required /></div><div class="field"><label>Ролі</label>${roleCheckboxes(["student"])}</div><button class="btn primary" type="submit">Створити акаунт</button></form></div>
        <div class="card"><h2>Доступи</h2><p class="muted">Призупинення зберігає історію. Видалення після підтвердження прибирає акаунт і пов’язані дані назавжди.</p><div class="list">${state.data.memberships.filter((member) => member.status === "suspended").map((member) => `<div class="item"><div><p class="item-title">${escape(nameOf(member.user_id))}</p><div class="meta">${escape(roleTitles(membershipRoles(member)).join(", "))} · доступ призупинено</div></div><button class="btn small secondary" type="button" data-action="activate-user" data-user-id="${member.user_id}">Відновити</button></div>`).join("") || empty("Призупинених акаунтів немає.")}</div></div>
      </div>
      <div class="card"><h2>Активні зв’язки</h2><div class="relation-list">${state.data.teacherStudents.map((relation) => `<div class="item"><strong>${escape(nameOf(relation.teacher_id))}</strong><span>викладає</span><strong>${escape(nameOf(relation.student_id))}</strong><button class="btn small secondary" type="button" data-action="remove-assignment" data-relation-id="${relation.id}">Прибрати</button></div>`).join("") || empty("Ще немає призначень.")}</div></div>
      <div class="work-grid"><div class="card"><h2>Викладачі</h2>${renderPeopleList(teachers)}</div><div class="card"><h2>Учні</h2>${renderPeopleList(students)}</div></div>
      ${state.selectedStudentId ? renderStudentInternalCard(state.selectedStudentId) : ""}
    `;
  }

  function renderSubjectsAndRates() {
    const teachers = activeMembers("teacher");
    const students = activeMembers("student");
    return `
      <div class="page-heading"><div><p class="eyebrow">Навчання і тарифи</p><h1>Предмети та ціни</h1><p class="muted">Ціна для учня і виплата викладачу зберігаються окремо.</p></div></div>
      <div class="work-grid">
        <div class="card"><h2>Новий предмет</h2><form id="createSubjectForm" class="stack"><div class="field"><label>Назва</label><input name="name" placeholder="Наприклад, Математика" required /></div><div class="field"><label>Колір у календарі</label><input name="color" type="color" value="#0f766e" /></div><div class="field"><label>Тривалість, хв</label><input name="duration" type="number" min="15" max="240" value="60" /></div><button class="btn primary" type="submit">Додати предмет</button></form></div>
        <div class="card"><h2>Новий тариф</h2><form id="createRateForm" class="stack">
          ${selectField("studentId", "Учень", students, true)}
          ${selectField("teacherId", "Викладач", teachers, false, "")}
          ${subjectSelect("subjectId", "Предмет", false, "")}
          <div class="two-fields"><div class="field"><label>Ціна уроку, грн</label><input name="lessonPrice" type="number" min="0" step="1" required /></div><div class="field"><label>Виплата викладачу, грн</label><input name="teacherPayout" type="number" min="0" step="1" required /></div></div>
          <div class="field"><label>Діє з</label><input name="activeFrom" type="date" value="${isoDate(new Date())}" required /></div><button class="btn primary" type="submit">Зберегти тариф</button>
        </form></div>
      </div>
      <div class="card"><h2>Предмети</h2><div class="chip-row">${state.data.subjects.map((item) => `<span class="subject-chip"><i style="background:${escapeAttr(item.color)}"></i>${escape(item.name)} · ${item.default_duration_minutes} хв</span>`).join("") || empty("Спочатку додай хоча б один предмет.")}</div></div>
      <div class="card"><h2>Історія тарифів</h2><div class="list">${state.data.rates.map((rate) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(rate.student_id))}</p><div class="meta">${escape(rate.teacher_id ? nameOf(rate.teacher_id) : "Усі викладачі")} · ${escape(rate.subject_id ? subjectName(rate.subject_id) : "Усі предмети")}</div></div><strong>${money(rate.lesson_price_uah)} / виплата ${money(rate.teacher_payout_uah)}</strong></div></div>`).join("") || empty("Тарифів ще немає.")}</div></div>
    `;
  }

  function renderFinance() {
    const balances = walletBalances();
    const teacherDaily = teacherDailyTotals();
    return `
      <div class="page-heading"><div><p class="eyebrow">Фінанси</p><h1>Гаманці та виплати</h1><p class="muted">Баланс обчислюється тільки з журналу операцій.</p></div></div>
      <div class="work-grid"><div class="card"><h2>Баланс учнів</h2><div class="list">${activeMembers("student").map((student) => { const entry = balances[student.user_id] || { balance: 0, paid: 0, spent: 0 }; return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(student.user_id))}</p><div class="meta">Оплачено ${money(entry.paid)} · списано ${money(entry.spent)}</div></div><strong class="${entry.balance < 0 ? "amount-negative" : "amount-positive"}">${money(entry.balance)}</strong></div></div>`; }).join("") || empty("Немає учнів.")}</div></div>
      <div class="card"><h2>Виплати викладачам за днями</h2><div class="list">${teacherDaily.map((row) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(row.date)} · ${escape(nameOf(row.teacherId))}</p><div class="meta">За проведені або платно скасовані уроки</div></div><strong>${money(row.total)}</strong></div></div>`).join("") || empty("Ще немає нарахувань.")}</div></div></div>
      <div class="card"><h2>Останні операції</h2><div class="list">${state.data.ledger.slice(0, 30).map((row) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(row.student_id))} · ${ledgerLabel(row.kind)}</p><div class="meta">${formatDateTime(row.created_at)} · ${escape(row.note || "Без коментаря")}</div></div><strong class="${row.amount_uah >= 0 ? "amount-positive" : "amount-negative"}">${signedMoney(row.amount_uah)}</strong></div></div>`).join("") || empty("Операцій ще немає.")}</div></div>
    `;
  }

  function renderAdminPayments() {
    const students = activeMembers("student");
    return `
      <div class="page-heading"><div><p class="eyebrow">Оплати</p><h1>Зафіксувати оплату</h1><p class="muted">Обери учня, який вніс оплату. Запис одразу потрапить до фінансового журналу.</p></div></div>
      <div class="work-grid"><div class="card"><h2>Нова оплата</h2><form id="recordPaymentForm" class="stack">${selectField("studentId", "Учень", students, true)}<div class="field"><label>Сума, грн</label><input name="amount" type="number" step="1" min="1" required /></div><div class="field"><label>Коментар</label><textarea name="note" placeholder="Наприклад: оплата за вересень готівкою"></textarea></div><button class="btn primary" type="submit">Внести оплату</button></form></div><div class="card"><h2>Що відбувається після збереження</h2><div class="process-note"><strong>1.</strong> Оплата додається до фінансового журналу.<br><strong>2.</strong> Баланс учня оновлюється одразу.<br><strong>3.</strong> Проведені уроки списуються автоматично за встановленим тарифом.</div></div></div>
      <div class="card"><h2>Останні оплати</h2><div class="list">${state.data.ledger.filter((row) => row.kind === "payment").slice(0, 20).map((row) => `<div class="item"><div><p class="item-title">${escape(nameOf(row.student_id))}</p><div class="meta">${formatDateTime(row.created_at)} · ${escape(row.note || "Без коментаря")}</div></div><strong class="amount-positive">${signedMoney(row.amount_uah)}</strong></div>`).join("") || empty("Оплат ще немає.")}</div></div>
    `;
  }

  function renderTeacherView() {
    if (state.activeView === "students") return renderTeacherStudents();
    if (state.activeView === "homework") return renderTeacherHomework();
    return renderTeacherCalendar();
  }

  function renderTeacherCalendar() {
    const lessons = state.data.lessons.filter((lesson) => lesson.teacher_id === state.session.user.id);
    const selected = selectedLesson();
    const ownStudents = teacherStudents();
    const todayLessons = lessons.filter((lesson) => localDate(lesson.starts_at) === isoDate(new Date()));
    return `
      <div class="page-heading"><div><p class="eyebrow">Мій розклад</p><h1>Календар викладача</h1><p class="muted">Створи заняття, відміть його статус і працюй з домашніми без переходів між системами.</p></div></div>
      <div class="metric-grid">${metricCard("Сьогодні", todayLessons.length, "занять")}${metricCard("Мої учні", ownStudents.length, "активних")}${metricCard("Заплановано", lessons.filter((item) => item.status === "planned").length, "у розкладі")}${metricCard("На перевірці", teacherHomeworkStudents().filter((item) => item.status === "submitted").length, "робіт")}</div>
      <div class="calendar-workspace">
        <div class="card calendar-column"><div class="calendar-actions"><h2>Календар</h2><button class="btn small secondary" data-action="calendar-today">Сьогодні</button></div>${renderCalendar(lessons)}</div>
        <div class="card day-column"><h2>${formatDate(state.selectedDate)}</h2><div class="list">${renderLessonCards(dayLessons(lessons), true)}</div><div class="filebox"><strong>Вільні вікна</strong><div class="meta">${freeSlots(dayLessons(lessons)).join(", ") || "На цей день вільних годин у робочому діапазоні немає."}</div></div></div>
      </div>
      <div class="work-grid"><div class="card"><h2>Нове заняття</h2>${renderLessonForm(ownStudents)}</div><div class="card"><h2>Картка заняття</h2>${selected ? renderLessonPanel(selected) : empty("Обери заняття в списку дня, щоб змінити статус, додати файл або домашнє.")}</div></div>
    `;
  }

  function renderTeacherStudents() {
    const students = teacherStudents();
    return `
      <div class="page-heading"><div><p class="eyebrow">Моя група</p><h1>Учні</h1><p class="muted">Тут відображаються лише учні, яких закріпив адміністратор.</p></div></div>
      <div class="card"><div class="list">${students.map((student) => {
        const upcoming = state.data.lessons.filter((lesson) => lesson.teacher_id === state.session.user.id && lessonStudents(lesson.id).some((row) => row.student_id === student.id) && new Date(lesson.starts_at) >= new Date()).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
        const submitted = teacherHomeworkStudents().filter((row) => row.student_id === student.id && row.status === "submitted").length;
        return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(student.full_name)}</p><div class="meta">Наступний урок: ${upcoming ? escape(formatDateTime(upcoming.starts_at)) + " · " + escape(subjectName(upcoming.subject_id)) : "не заплановано"}</div><div class="meta">Робіт на перевірці: ${submitted}</div></div><div class="item-actions"><span class="role-badge role-student">Учень</span><button class="btn small secondary" type="button" data-action="open-student-card" data-student-id="${student.id}">Картка учня</button></div></div></div>`;
      }).join("") || empty("Адміністратор ще не призначив тобі учнів.")}</div></div>
      ${state.selectedStudentId ? renderStudentInternalCard(state.selectedStudentId) : ""}
    `;
  }

  function renderTeacherHomework() {
    const tasks = state.data.homework.filter((task) => task.teacher_id === state.session.user.id);
    const selected = selectedLesson();
    return `
      <div class="page-heading"><div><p class="eyebrow">Перевірка</p><h1>Домашні завдання</h1><p class="muted">Публікуй завдання, дивись відповіді й повертай роботу на доопрацювання.</p></div></div>
      <div class="work-grid"><div class="card"><h2>Нове домашнє</h2>${renderHomeworkForm(selected)}</div><div class="card"><h2>На перевірці</h2>${renderTeacherHomeworkReview(tasks)}</div></div>
    `;
  }

  function renderStudentView() {
    if (state.activeView === "calendar") return renderStudentCalendar();
    if (state.activeView === "homework") return renderStudentHomework();
    return renderStudentToday();
  }

  function renderStudentToday() {
    const lessons = myLessons();
    const tasks = myHomeworkStudents();
    const today = isoDate(new Date());
    const todayLessons = lessons.filter((lesson) => localDate(lesson.starts_at) === today);
    const pendingTasks = tasks.filter((task) => task.status !== "reviewed");
    const overdue = tasks.filter((task) => { const homework = homeworkById(task.homework_id); return homework?.deadline_at && homework.deadline_at < new Date().toISOString() && task.status === "not_started"; });
    return `
      <div class="page-heading"><div><p class="eyebrow">Мій день</p><h1>Навчальний план</h1><p class="muted">Уроки, домашні та коментарі викладача в одному місці.</p></div></div>
      <div class="metric-grid">${metricCard("Уроків сьогодні", todayLessons.length, "перевір календар")}${metricCard("Активні домашні", pendingTasks.length, "потрібна дія")}${metricCard("Прострочено", overdue.length, "варто здати")}${metricCard("Матеріали", state.data.attachments.length, "доступних файлів")}</div>
      <div class="work-grid"><div class="card"><h2>Сьогодні</h2>${renderLessonFeed(todayLessons)}</div><div class="card"><h2>Потрібно зробити</h2>${renderStudentTaskFeed(pendingTasks.slice(0, 6))}</div></div>
      <div class="card"><h2>Найближчі 7 днів</h2>${renderLessonFeed(nextLessons(8, lessons))}</div>
    `;
  }

  function renderStudentCalendar() {
    const lessons = myLessons();
    return `
      <div class="page-heading"><div><p class="eyebrow">Розклад</p><h1>Мій календар</h1><p class="muted">Статус уроку встановлює викладач. Ти бачиш усі зміни одразу.</p></div></div>
      <div class="calendar-workspace"><div class="card calendar-column"><div class="calendar-actions"><h2>Календар</h2><button class="btn small secondary" data-action="calendar-today">Сьогодні</button></div>${renderCalendar(lessons)}</div><div class="card day-column"><h2>${formatDate(state.selectedDate)}</h2>${renderLessonCards(dayLessons(lessons), false)}</div></div>
    `;
  }

  function renderStudentHomework() {
    const tasks = myHomeworkStudents();
    return `
      <div class="page-heading"><div><p class="eyebrow">Домашні завдання</p><h1>Мої роботи</h1><p class="muted">Надсилай текст або файл і повертайся до коментаря викладача.</p></div></div>
      <div class="list">${tasks.map((item) => renderStudentHomeworkCard(item)).join("") || empty("Домашніх завдань поки немає.")}</div>
    `;
  }

  function renderLessonForm(students) {
    const defaultStart = dateTimeLocal(state.selectedDate, "15:00");
    const defaultEnd = dateTimeLocal(state.selectedDate, "16:00");
    return `
      <form id="createLessonForm" class="stack">
        ${subjectSelect("subjectId", "Предмет", true)}
        <div class="field"><label>Назва заняття <span class="field-optional">(необов’язково)</span></label><input name="title" placeholder="Якщо лишити порожнім, буде назва предмета" /></div>
        <div class="two-fields"><div class="field"><label>Початок</label><input name="startsAt" type="datetime-local" value="${defaultStart}" required /></div><div class="field"><label>Кінець</label><input name="endsAt" type="datetime-local" value="${defaultEnd}" required /></div></div>
        ${selectField("studentIds", "Учні", students.map((student) => ({ user_id: student.id })), true, null, true)}
        <div class="field"><label>Посилання на зустріч</label><input name="meetingUrl" type="url" placeholder="https://..." /></div>
        <div class="field"><label>Місце / платформа</label><input name="location" placeholder="Zoom, Google Meet або кабінет 12" /></div>
        <button class="btn primary" type="submit">Створити заняття</button>
      </form>
    `;
  }

  function renderLessonPanel(lesson) {
    const participants = lessonStudents(lesson.id);
    const lessonTasks = state.data.homework.filter((task) => task.lesson_id === lesson.id);
    return `
      <div class="lesson-focus">
        <div class="item"><div class="item-head"><div><p class="item-title">${escape(subjectName(lesson.subject_id))} · ${escape(lesson.title)}</p><div class="meta">${escape(formatDateTime(lesson.starts_at))} — ${escape(formatTime(lesson.ends_at))}</div><div class="meta">${escape(participants.map((row) => nameOf(row.student_id)).join(", "))}</div></div>${statusBadge(lesson.status)}</div>${lesson.meeting_url ? `<a href="${escapeAttr(lesson.meeting_url)}" target="_blank" rel="noopener">Відкрити зустріч</a>` : ""}${renderAttachments({ lesson_id: lesson.id })}</div>
        <form id="lessonCardForm" class="stack" style="margin-top:12px;"><input type="hidden" name="lessonId" value="${lesson.id}" />
          <div class="field"><label>Статус</label><select name="status">${lessonStatusOptions(lesson.status)}</select></div>
          <div class="field"><label>Нотатки викладача</label><textarea name="teacherNote" placeholder="Що пройшли, що повторити наступного разу">${escape(lesson.teacher_note || "")}</textarea></div>
          <div class="filebox stack"><strong>Домашнє до цього уроку <span class="field-optional">(необов’язково)</span></strong><div class="field"><label>Назва</label><input name="homeworkTitle" /></div><div class="field"><label>Опис</label><textarea name="homeworkDescription"></textarea></div><div class="field"><label>Дедлайн</label><input name="homeworkDeadline" type="datetime-local" /></div>${renderVoiceCapture(`homework-${lesson.id}`, "Голосова інструкція")}${renderVideoCapture(`homework-video-${lesson.id}`, "Відеоінструкція")}<div class="field"><label>Файли до домашнього</label><input name="homeworkFiles" type="file" multiple accept="${supportedFileAccept()}" /></div></div>
          <div class="filebox stack"><strong>Матеріали до уроку <span class="field-optional">(необов’язково)</span></strong><input name="lessonFiles" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" /></div>
          <button class="btn primary" type="submit">Зберегти картку заняття</button>
        </form>
        <div style="margin-top:12px;"><strong>Домашні до уроку</strong>${lessonTasks.length ? `<div class="list" style="margin-top:8px;">${lessonTasks.map((task) => `<div class="item"><p class="item-title">${escape(task.title)}</p><div class="meta">${task.deadline_at ? "Дедлайн: " + escape(formatDateTime(task.deadline_at)) : "Без дедлайну"}</div></div>`).join("")}</div>` : '<div class="meta">Ще не опубліковано.</div>'}</div>
      </div>
    `;
  }

  function renderHomeworkForm(selected) {
    const students = teacherStudents();
    return `
      <form id="createHomeworkForm" class="stack">
        <div class="field"><label>Пов’язати із заняттям</label><select name="lessonId"><option value="">Без прив’язки</option>${state.data.lessons.filter((lesson) => lesson.teacher_id === state.session.user.id).map((lesson) => `<option value="${lesson.id}" ${selected?.id === lesson.id ? "selected" : ""}>${escape(homeworkLessonLabel(lesson))}</option>`).join("")}</select></div>
        <div class="field"><label>Назва</label><input name="title" required /></div><div class="field"><label>Опис</label><textarea name="description"></textarea></div><div class="field"><label>Дедлайн</label><input name="deadline" type="datetime-local" /></div>
        ${selected ? "" : selectField("studentIds", "Учні", students.map((student) => ({ user_id: student.id })), true, null, true)}
        ${renderVoiceCapture(`homework-${selected?.id || "new"}`, "Голосова інструкція")}${renderVideoCapture(`homework-video-${selected?.id || "new"}`, "Відеоінструкція")}
        <div class="field"><label>Вкладення</label><input name="files" type="file" multiple accept="${supportedFileAccept()}" /></div><button class="btn primary" type="submit">Опублікувати</button>
      </form>
    `;
  }

  function renderTeacherHomeworkReview(tasks) {
    const rows = tasks.flatMap((task) => homeworkStudents(task.id).map((recipient) => ({ task, recipient }))).filter((row) => row.recipient.status !== "not_started");
    return `<div class="list">${rows.length ? rows.map(({ task, recipient }) => {
      const submissions = submissionsFor(recipient.id);
      return `<div class="item"><p class="item-title">${escape(homeworkReviewLabel(task, recipient))}</p><div class="meta">Завдання: ${escape(task.title)} · статус: ${submissionLabel(recipient.status)}${recipient.grade ? " · оцінка: " + escape(recipient.grade) : ""}</div>${submissions.map((submission) => `<div class="filebox"><div>${escape(submission.body || "Файли без тексту")}</div>${renderAttachments({ submission_id: submission.id })}</div>`).join("")}${recipient.teacher_comment ? `<div class="meta">Мій коментар: ${escape(recipient.teacher_comment)}</div>` : ""}<form id="feedbackForm" class="stack" style="margin-top:8px;"><input type="hidden" name="homeworkStudentId" value="${recipient.id}" /><div class="two-fields"><div class="field"><label>Статус</label><select name="status"><option value="reviewed">Перевірено</option><option value="needs_revision">На доопрацювання</option></select></div><div class="field"><label>Оцінка</label><input name="grade" placeholder="Наприклад, 11/12" value="${escapeAttr(recipient.grade || "")}" /></div></div><div class="field"><label>Коментар</label><textarea name="comment">${escape(recipient.teacher_comment || "")}</textarea></div>${renderVoiceCapture(`feedback-${recipient.id}`, "Голосовий коментар")}${renderVideoCapture(`feedback-video-${recipient.id}`, "Відеокоментар")}<div class="field"><label>Виправлений файл</label><input name="files" type="file" multiple accept="${supportedFileAccept()}" /></div><button class="btn small secondary" type="submit">Надіслати зворотний зв’язок</button></form></div>`;
    }).join("") : empty("Надісланих робіт ще немає.")}</div>`;
  }

  function renderStudentHomeworkCard(recipient) {
    const task = homeworkById(recipient.homework_id);
    if (!task) return "";
    const submissions = submissionsFor(recipient.id);
    return `
      <article class="card homework-card"><div class="item-head"><div><p class="eyebrow">${task.deadline_at ? "Дедлайн: " + escape(formatDateTime(task.deadline_at)) : "Без дедлайну"}</p><h2>${escape(task.title)}</h2></div>${submissionBadge(recipient.status)}</div><p>${escape(task.description || "Без опису")}</p>${renderAttachments({ homework_id: task.id })}${recipient.teacher_comment ? `<div class="feedback-box"><strong>Коментар викладача</strong><div>${escape(recipient.teacher_comment)}</div>${recipient.grade ? `<div>Оцінка: ${escape(recipient.grade)}</div>` : ""}${renderAttachments({ homework_student_id: recipient.id })}</div>` : ""}${submissions.length ? `<div class="filebox"><strong>Мої відповіді</strong>${submissions.map((submission) => `<div class="meta">${escape(formatDateTime(submission.submitted_at))}: ${escape(submission.body || "Файли")}${renderAttachments({ submission_id: submission.id })}</div>`).join("")}</div>` : ""}<form id="submitHomeworkForm" class="stack" style="margin-top:12px;"><input type="hidden" name="homeworkStudentId" value="${recipient.id}" /><div class="field"><label>Моя відповідь</label><textarea name="body" placeholder="Опиши розв’язання або додай посилання"></textarea></div>${renderVoiceCapture(`submission-${recipient.id}`, "Голосова відповідь")}${renderVideoCapture(`submission-video-${recipient.id}`, "Відеовідповідь")}<div class="field"><label>Файли відповіді</label><input name="files" type="file" multiple accept="${supportedFileAccept()}" /></div><button class="btn primary" type="submit">Надіслати відповідь</button></form></article>
    `;
  }

  function renderLessonFeed(lessons) {
    return `<div class="list">${lessons.length ? lessons.map((lesson) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(formatDateTime(lesson.starts_at))} · ${escape(subjectName(lesson.subject_id))}</p><div class="meta">${escape(lesson.title)}</div>${lesson.meeting_url ? `<a href="${escapeAttr(lesson.meeting_url)}" target="_blank" rel="noopener">Перейти до зустрічі</a>` : ""}${renderAttachments({ lesson_id: lesson.id })}</div>${statusBadge(lesson.status)}</div></div>`).join("") : empty("Немає запланованих занять.")}</div>`;
  }

  function renderLessonCards(lessons, selectable) {
    return lessons.length ? lessons.map((lesson) => {
      const content = `<div class="lesson-card-head"><strong>${escape(formatTime(lesson.starts_at))} · ${escape(subjectName(lesson.subject_id))}</strong>${statusBadge(lesson.status)}</div><div>${escape(lesson.title)}</div><div class="meta">${escape(lessonStudents(lesson.id).map((row) => nameOf(row.student_id)).join(", ") || "Без учнів")}</div>${selectable ? "" : renderAttachments({ lesson_id: lesson.id })}`;
      return selectable
        ? `<button class="lesson-card ${state.selectedLessonId === lesson.id ? "active" : ""}" type="button" data-action="select-lesson" data-lesson-id="${lesson.id}">${content}</button>`
        : `<article class="lesson-card">${content}</article>`;
    }).join("") : empty("На цей день занять немає.");
  }

  function renderStudentTaskFeed(tasks) {
    return `<div class="list">${tasks.length ? tasks.map((item) => { const task = homeworkById(item.homework_id); return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(task?.title || "Домашнє")}</p><div class="meta">${task?.deadline_at ? "Дедлайн: " + escape(formatDateTime(task.deadline_at)) : "Без дедлайну"}</div></div>${submissionBadge(item.status)}</div></div>`; }).join("") : empty("Усе виконано.")}</div>`;
  }

  function renderCalendar(lessons) {
    const now = new Date();
    const view = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + state.calendarOffset, 1, 12));
    const year = view.getUTCFullYear();
    const month = view.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1, 12));
    const firstWeekday = (first.getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    const cells = [];

    for (let blank = 0; blank < firstWeekday; blank += 1) cells.push('<span class="calendar-day blank" aria-hidden="true"></span>');
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const count = lessons.filter((lesson) => localDate(lesson.starts_at) === date).length;
      const classes = ["calendar-day"];
      if (date === isoDate(new Date())) classes.push("today");
      if (date === state.selectedDate) classes.push("selected");
      cells.push(`<button type="button" class="${classes.join(" ")}" data-action="select-date" data-date="${date}"><span>${day}</span>${count ? `<b class="calendar-count">${count}</b>` : ""}</button>`);
    }
    while (cells.length % 7) cells.push('<span class="calendar-day blank" aria-hidden="true"></span>');

    return `
      <div class="calendar-header"><button class="icon-btn" type="button" data-action="calendar-prev" aria-label="Попередній місяць">‹</button><strong>${monthTitle(view)}</strong><button class="icon-btn" type="button" data-action="calendar-next" aria-label="Наступний місяць">›</button></div>
      <div class="calendar-weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Нд</span></div>
      <div class="calendar-grid">${cells.join("")}</div>
    `;
  }

  function renderAttachments(target) {
    const files = state.data.attachments.filter((file) => Object.entries(target).every(([key, item]) => file[key] === item));
    if (!files.length) return "";
    return `<div class="attachment-list">${files.map((file) => `<button class="attachment" type="button" data-action="download-file" data-file-id="${file.id}">Завантажити: ${escape(file.original_name)}${file.byte_size ? ` <span>${formatBytes(file.byte_size)}</span>` : ""}</button>`).join("")}</div>`;
  }

  function renderVoiceCapture(captureId, label) {
    return renderMediaCapture(captureId, label, "audio");
  }

  function renderVideoCapture(captureId, label) {
    return renderMediaCapture(captureId, label, "video");
  }

  function renderMediaCapture(captureId, label, kind) {
    const isVideo = kind === "video";
    const accept = isVideo ? "video/webm,video/mp4" : "audio/webm,audio/ogg,audio/mp4,audio/mpeg";
    const helper = isVideo
      ? "Запиши коротке відео в браузері. Файл додасться до форми після зупинки запису."
      : "Запиши відповідь у браузері: аудіофайл додасться до форми після зупинки запису.";
    return `
      <div class="media-capture" data-media-capture="${escapeAttr(captureId)}" data-capture-kind="${kind}">
        <div><strong>${escape(label)}</strong><div class="meta">${helper}</div></div>
        <input type="file" hidden data-recorded-media="${escapeAttr(captureId)}" accept="${accept}" />
        <div class="media-capture-actions"><button class="btn small secondary" type="button" data-action="start-media-recording" data-capture-id="${escapeAttr(captureId)}">Почати запис</button><button class="btn small danger" type="button" data-action="stop-media-recording" data-capture-id="${escapeAttr(captureId)}" disabled>Зупинити</button><button class="btn small secondary" type="button" data-action="clear-media-recording" disabled>Видалити запис</button></div>
        <div class="media-preview" data-capture-preview></div>
        <div class="meta" data-capture-status>Запис ще не додано.</div>
      </div>
    `;
  }

  function supportedFileAccept() {
    return ".pdf,.jpg,.jpeg,.png,.webp,.docx,.webm,.ogg,.mp3,.m4a,.mp4";
  }

  async function startMediaRecording(trigger) {
    const captureId = trigger.dataset.captureId;
    const capture = trigger.closest("[data-media-capture]");
    if (!capture || !captureId) throw new Error("Не вдалося підготувати запис.");
    if (state.recording) throw new Error("Спершу зупини поточний запис голосу.");
    const kind = capture.dataset.captureKind || "audio";
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Цей браузер не підтримує запис. Додай файл вручну.");

    const stream = await navigator.mediaDevices.getUserMedia(kind === "video" ? { audio: true, video: true } : { audio: true });
    clearMediaRecording(capture, false);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const status = capture.querySelector("[data-capture-status]");
    const stopButton = capture.querySelector('[data-action="stop-media-recording"]');
    const clearButton = capture.querySelector('[data-action="clear-media-recording"]');
    const input = capture.querySelector("input[data-recorded-media]");
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      stream.getTracks().forEach((track) => track.stop());
      state.recording = null;
      trigger.disabled = false;
      trigger.textContent = "Почати запис";
      if (stopButton) stopButton.disabled = true;
      if (clearButton) clearButton.disabled = true;
      if (status) status.textContent = "Не вдалося завершити запис. Спробуй ще раз або додай файл вручну.";
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      const mimeType = recorder.mimeType || (kind === "video" ? "video/webm" : "audio/webm");
      const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? (kind === "video" ? "mp4" : "m4a") : "webm";
      const recordingFile = new File(chunks, `${kind}-message-${Date.now()}.${extension}`, { type: mimeType });
      if (input) {
        const transfer = new DataTransfer();
        transfer.items.add(recordingFile);
        input.files = transfer.files;
      }
      setMediaPreview(capture, recordingFile);
      state.recording = null;
      trigger.disabled = false;
      trigger.textContent = "Перезаписати";
      if (stopButton) stopButton.disabled = true;
      if (clearButton) clearButton.disabled = false;
      if (status) status.textContent = `Запис додано: ${recordingFile.name} (${formatBytes(recordingFile.size)}). Він завантажиться після надсилання форми.`;
    });
    state.recording = { captureId, recorder, stream };
    trigger.disabled = true;
    trigger.textContent = "Йде запис...";
    if (stopButton) stopButton.disabled = false;
    if (clearButton) clearButton.disabled = true;
    if (status) status.textContent = kind === "video" ? "Йде запис відео..." : "Йде запис голосу...";
    recorder.start();
  }

  function stopMediaRecording(captureId) {
    if (!state.recording || state.recording.captureId !== captureId) return;
    if (state.recording.recorder.state !== "inactive") state.recording.recorder.stop();
  }

  function clearMediaRecording(triggerOrCapture, announce = true) {
    const capture = triggerOrCapture?.matches?.("[data-media-capture]") ? triggerOrCapture : triggerOrCapture?.closest?.("[data-media-capture]");
    if (!capture) return;
    const input = capture.querySelector("input[data-recorded-media]");
    const preview = capture.querySelector("[data-capture-preview]");
    const status = capture.querySelector("[data-capture-status]");
    const startButton = capture.querySelector('[data-action="start-media-recording"]');
    const clearButton = capture.querySelector('[data-action="clear-media-recording"]');
    if (preview?.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    if (preview) {
      preview.innerHTML = "";
      delete preview.dataset.objectUrl;
    }
    if (input) input.value = "";
    if (startButton && !state.recording) {
      startButton.disabled = false;
      startButton.textContent = "Почати запис";
    }
    if (clearButton) clearButton.disabled = true;
    if (status) status.textContent = announce ? "Запис видалено. Можна записати новий." : "Запис ще не додано.";
  }

  function setMediaPreview(capture, file) {
    const preview = capture.querySelector("[data-capture-preview]");
    if (!preview) return;
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    preview.dataset.objectUrl = objectUrl;
    const element = capture.dataset.captureKind === "video" ? "video" : "audio";
    const fallback = element === "video" ? "Ваш браузер не підтримує відтворення відео." : "Ваш браузер не підтримує відтворення аудіо.";
    preview.innerHTML = `<${element} controls preload="metadata" src="${escapeAttr(objectUrl)}">${fallback}</${element}>`;
  }

  function hasSelectedFiles(form, selector = 'input[type="file"]') {
    return Array.from(form?.querySelectorAll(selector) || []).some((input) => input.files?.length);
  }

  async function uploadInputFiles(form, target, selector = 'input[type="file"]') {
    const inputs = Array.from(form?.querySelectorAll(selector) || []);
    const files = inputs.flatMap((input) => Array.from(input.files || []));
    if (!files.length) return;
    const allowed = new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/mpeg",
      "audio/x-m4a",
      "video/webm",
      "video/mp4"
    ]);

    for (const file of files) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const allowedExtension = ["pdf", "jpg", "jpeg", "png", "webp", "docx", "webm", "ogg", "mp3", "m4a", "mp4"].includes(extension);
      if (file.size > 50 * 1024 * 1024) throw new Error(`Файл «${file.name}» перевищує ліміт 50 МБ.`);
      if (!allowedExtension || (file.type && !allowed.has(file.type))) throw new Error(`Формат файлу «${file.name}» не підтримується.`);

      const fileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const random = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const storagePath = `${state.session.user.id}/${random}-${fileName}`;
      const mimeType = file.type || mimeTypeForExtension(extension);
      const { error: uploadError } = await state.client.storage.from("portal-files").upload(storagePath, file, {
        cacheControl: "3600",
        contentType: mimeType,
        upsert: false
      });
      if (uploadError) throw uploadError;

      const { error: attachmentError } = await state.client.rpc("register_file_attachment", {
        p_school_id: state.school.id,
        p_storage_path: storagePath,
        p_original_name: file.name,
        p_mime_type: mimeType,
        p_byte_size: file.size,
        p_lesson_id: target.lesson_id || null,
        p_homework_id: target.homework_id || null,
        p_submission_id: target.submission_id || null,
        p_homework_student_id: target.homework_student_id || null
      });
      if (attachmentError) {
        await state.client.storage.from("portal-files").remove([storagePath]);
        throw attachmentError;
      }
    }
  }

  function mimeTypeForExtension(extension) {
    const mimeTypes = {
      pdf: "application/pdf",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      webm: "audio/webm",
      ogg: "audio/ogg",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "video/mp4"
    };
    return mimeTypes[extension] || "application/octet-stream";
  }

  async function downloadAttachment(fileId) {
    const file = state.data.attachments.find((item) => item.id === fileId);
    if (!file) throw new Error("Файл більше недоступний.");
    const { data, error } = await state.client.storage.from("portal-files").createSignedUrl(file.storage_path, 60 * 10);
    if (error) throw error;
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function updateHomeworkStudent(id, changes) {
    const { error } = await state.client.from("homework_students").update(changes).eq("id", id);
    if (error) throw error;
    state.notice = success("Статус роботи оновлено.");
    await refreshContext();
  }

  function renderCurrent() {
    if (state.membership && state.school) renderDashboard();
    else if (state.session) renderOnboarding(null);
    else renderAuth();
  }

  function setLoading(loading) {
    state.loading = loading;
    document.body.classList.toggle("is-loading", loading);
  }

  function value(form, name) {
    return String(new FormData(form).get(name) || "").trim();
  }

  function storedRegistrationDetails() {
    const metadata = state.session?.user?.user_metadata || {};
    const fullName = String(metadata.full_name || "").trim();
    const requestedRole = String(metadata.requested_role || "").trim();
    if (fullName.length < 2 || !["student", "teacher"].includes(requestedRole)) return null;
    return { fullName, requestedRole };
  }

  function values(form, name) {
    return Array.from(form.querySelectorAll(`[name="${name}"] option:checked, input[name="${name}"]:checked`)).map((option) => option.value).filter(Boolean);
  }

  function wholeUah(raw) {
    const amount = Number(raw);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Сума має бути цілим числом у гривнях без копійок.");
    return amount;
  }

  function activeMembers(role) {
    return state.data.memberships.filter((member) => member.status === "active" && membershipRoles(member).includes(role));
  }

  function teacherStudents() {
    const ids = state.data.teacherStudents.filter((relation) => relation.teacher_id === state.session.user.id).map((relation) => relation.student_id);
    return ids.map((id) => state.data.profiles.find((profile) => profile.id === id)).filter(Boolean);
  }

  function canManageStudentCard(studentId) {
    return state.activeRole === "admin" || (state.activeRole === "teacher" && state.data.teacherStudents.some((relation) => relation.teacher_id === state.session.user.id && relation.student_id === studentId));
  }

  function myLessons() {
    const ids = new Set(state.data.lessonStudents.filter((item) => item.student_id === state.session.user.id).map((item) => item.lesson_id));
    return state.data.lessons.filter((lesson) => ids.has(lesson.id));
  }

  function myHomeworkStudents() {
    return state.data.homeworkStudents.filter((item) => item.student_id === state.session.user.id).sort((a, b) => {
      const deadlineA = homeworkById(a.homework_id)?.deadline_at || "9999";
      const deadlineB = homeworkById(b.homework_id)?.deadline_at || "9999";
      return deadlineA.localeCompare(deadlineB);
    });
  }

  function teacherHomeworkStudents() {
    const ownHomework = new Set(state.data.homework.filter((item) => item.teacher_id === state.session.user.id).map((item) => item.id));
    return state.data.homeworkStudents.filter((item) => ownHomework.has(item.homework_id));
  }

  function lessonStudents(lessonId) {
    return state.data.lessonStudents.filter((item) => item.lesson_id === lessonId);
  }

  function homeworkStudents(homeworkId) {
    return state.data.homeworkStudents.filter((item) => item.homework_id === homeworkId);
  }

  function submissionsFor(homeworkStudentId) {
    return state.data.submissions.filter((item) => item.homework_student_id === homeworkStudentId).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  }

  function lessonById(id) {
    return state.data.lessons.find((item) => item.id === id) || null;
  }

  function homeworkById(id) {
    return state.data.homework.find((item) => item.id === id) || null;
  }

  function homeworkLessonLabel(lesson) {
    const studentNames = lessonStudents(lesson.id).map((item) => nameOf(item.student_id)).join(", ") || "Без учня";
    return `${formatDateTime(lesson.starts_at)} - ${subjectName(lesson.subject_id)} - ${studentNames}`;
  }

  function homeworkReviewLabel(task, recipient) {
    const lesson = task.lesson_id ? lessonById(task.lesson_id) : null;
    const date = lesson ? formatDateTime(lesson.starts_at) : formatDateTime(task.created_at);
    const subject = lesson ? subjectName(lesson.subject_id) : "Без предмета";
    return `${date} - ${subject} - ${nameOf(recipient.student_id)}`;
  }

  function selectedLesson() {
    return state.selectedLessonId ? lessonById(state.selectedLessonId) : null;
  }

  function dayLessons(lessons) {
    return lessons.filter((lesson) => localDate(lesson.starts_at) === state.selectedDate).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  function nextLessons(limit, source) {
    const now = new Date().toISOString();
    return (source || state.data.lessons).filter((lesson) => lesson.starts_at >= now).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, limit);
  }

  function freeSlots(lessons) {
    const free = [];
    for (let hour = 8; hour < 20; hour += 1) {
      const slotStart = new Date(`${state.selectedDate}T${String(hour).padStart(2, "0")}:00:00`);
      const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
      const occupied = lessons.some((lesson) => new Date(lesson.starts_at) < slotEnd && new Date(lesson.ends_at) > slotStart);
      if (!occupied) free.push(`${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`);
    }
    return free;
  }

  function walletBalances() {
    return state.data.ledger.filter((row) => row.status === "confirmed").reduce((result, row) => {
      if (!result[row.student_id]) result[row.student_id] = { balance: 0, paid: 0, spent: 0 };
      const item = result[row.student_id];
      item.balance += row.amount_uah;
      if (row.amount_uah > 0) item.paid += row.amount_uah;
      if (row.amount_uah < 0) item.spent += Math.abs(row.amount_uah);
      return result;
    }, {});
  }

  function teacherDailyTotals() {
    const grouped = new Map();
    state.data.ledger.filter((row) => row.status === "confirmed" && row.teacher_id && row.teacher_payout_uah).forEach((row) => {
      const date = localDate(row.created_at);
      const key = `${date}-${row.teacher_id}`;
      const item = grouped.get(key) || { date, teacherId: row.teacher_id, total: 0 };
      item.total += row.teacher_payout_uah;
      grouped.set(key, item);
    });
    return Array.from(grouped.values()).sort((a, b) => `${b.date}${b.teacherId}`.localeCompare(`${a.date}${a.teacherId}`));
  }

  function selectField(name, label, records, required, emptyLabel, multiple) {
    const options = records.map((record) => {
      const id = record.user_id || record.id;
      return `<option value="${escapeAttr(id)}">${escape(nameOf(id))}</option>`;
    }).join("");
    const emptyOption = emptyLabel !== undefined ? `<option value="" selected hidden>${escape(emptyLabel)}</option>` : "";
    return `<div class="field"><label>${escape(label)}</label><select name="${escapeAttr(name)}" ${required ? "required" : ""} ${multiple ? "multiple size=\"4\"" : ""}>${emptyOption}${options}</select>${multiple ? '<div class="meta">Щоб вибрати кількох учнів, утримуй Ctrl або Cmd.</div>' : ""}</div>`;
  }

  function subjectSelect(name, label, required, emptyLabel) {
    const options = state.data.subjects.filter((item) => item.is_active).map((item) => `<option value="${item.id}">${escape(item.name)}</option>`).join("");
    const emptyOption = emptyLabel !== undefined ? `<option value="" selected hidden>${escape(emptyLabel)}</option>` : "";
    return `<div class="field"><label>${escape(label)}</label><select name="${escapeAttr(name)}" ${required ? "required" : ""}>${emptyOption}${options}</select></div>`;
  }

  function renderPeopleList(members) {
    return `<div class="list">${members.map((member) => {
      const isSelf = member.user_id === state.session.user.id;
      const roles = membershipRoles(member);
      return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(member.user_id))}</p><div class="meta">${escape(isSelf ? "Цей акаунт" : "Активний доступ")}</div></div><div class="role-badges">${roleBadges(roles)}</div></div><form id="changeUserRolesForm" class="inline-form"><input type="hidden" name="userId" value="${member.user_id}" />${roleCheckboxes(roles)}<button class="btn small secondary" type="submit">Зберегти ролі</button>${roles.includes("student") ? `<button class="btn small secondary" type="button" data-action="open-student-card" data-student-id="${member.user_id}">Картка учня</button>` : ""}${isSelf ? "" : `<button class="btn small secondary" type="button" data-action="suspend-user" data-user-id="${member.user_id}">Призупинити</button><button class="btn small danger" type="button" data-action="delete-user" data-user-id="${member.user_id}" data-user-name="${escapeAttr(nameOf(member.user_id))}">Видалити</button>`}</form></div>`;
    }).join("") || empty("Поки немає активних користувачів.")}</div>`;
  }

  function renderStudentInternalCard(studentId) {
    if (!canManageStudentCard(studentId)) return "";
    const student = state.data.profiles.find((profile) => profile.id === studentId);
    if (!student) return "";
    const profile = state.data.studentInternalProfiles.find((item) => item.student_id === studentId) || {};
    const notes = state.data.studentInternalNotes.filter((item) => item.student_id === studentId);
    return `
      <section class="card student-internal-card">
        <div class="item-head"><div><p class="eyebrow">Лише для команди</p><h2>Картка учня: ${escape(student.full_name)}</h2><p class="muted">Ці відомості й нотатки недоступні учню.</p></div><button class="btn small secondary" type="button" data-action="close-student-card">Закрити</button></div>
        <form id="studentInternalCardForm" class="student-internal-form"><input type="hidden" name="studentId" value="${escapeAttr(studentId)}" />
          <div class="work-grid compact-grid">
          <div class="stack">
            <div class="field"><label>Мета навчання</label><textarea name="goal" placeholder="Наприклад: вільно говорити англійською для роботи">${escape(profile.goal || "")}</textarea></div>
            <div class="two-fields"><div class="field"><label>Рівень на старті</label><input name="startingLevel" value="${escapeAttr(profile.starting_level || "")}" placeholder="Наприклад: A2" /></div><div class="field"><label>Поточний рівень</label><input name="currentLevel" value="${escapeAttr(profile.current_level || "")}" placeholder="Наприклад: B1" /></div></div>
          </div>
          <div class="stack"><div><h3>Внутрішні нотатки</h3><p class="muted">Видно лише адміністраторам і викладачам цього учня.</p></div>
            <div class="field"><label>Нова нотатка <span class="field-optional">(необов’язково)</span></label><textarea name="body" maxlength="4000" placeholder="Спостереження, домовленість, наступний крок"></textarea></div>
            <div class="note-list">${notes.map((note) => `<div class="internal-note"><div class="meta">${escape(formatDateTime(note.created_at))} · ${escape(nameOf(note.author_id))}</div><div>${escape(note.body).replace(/\n/g, "<br>")}</div></div>`).join("") || empty("Внутрішніх нотаток ще немає.")}</div>
          </div>
          </div>
          <button class="btn primary" type="submit">Зберегти картку та нотатку</button>
        </form>
        ${renderStudentStatistics(studentId)}
      </section>
    `;
  }

  function renderStudentStatistics(studentId) {
    return `
      <section class="student-statistics" data-student-id="${escapeAttr(studentId)}">
        <div class="student-stats-head"><div><h3>Статистика учня</h3><p class="muted">За замовчуванням показано всю історію.</p></div><div class="student-stats-range"><label>Від<input type="date" data-student-stat-range="from" /></label><label>До<input type="date" data-student-stat-range="to" /></label><button class="btn small secondary" type="button" data-action="reset-student-statistics">За весь час</button></div></div>
        <div data-student-stats-results>${renderStudentStatisticsPanel(studentId, { id: "all", start: null, end: null })}</div>
      </section>
    `;
  }

  function refreshStudentStatistics(statistics) {
    if (!statistics) return;
    const studentId = statistics.dataset.studentId;
    const start = statistics.querySelector('[data-student-stat-range="from"]')?.value || null;
    const end = statistics.querySelector('[data-student-stat-range="to"]')?.value || null;
    const results = statistics.querySelector("[data-student-stats-results]");
    if (start && end && start > end) {
      if (results) results.innerHTML = '<div class="msg error">Дата «Від» не може бути пізнішою за дату «До».</div>';
      return;
    }
    if (results) results.innerHTML = renderStudentStatisticsPanel(studentId, { id: start || end ? "range" : "all", start, end });
  }

  function renderStudentStatisticsPanel(studentId, period, hidden) {
    const statistics = studentStatisticsForPeriod(studentId, period);
    const lessonMetrics = [
      ["Усього", statistics.total],
      ["Заплановано", statistics.planned],
      ["Проведено", statistics.completed],
      ["Скасовано", statistics.cancelled],
      ["Скасовано з оплатою", statistics.cancelledPaid]
    ];
    return `
      <div class="student-stats-panel" ${hidden ? "hidden" : ""}>
        <div class="student-stats-grid">${lessonMetrics.map(([label, amount]) => studentStatisticMetric(label, amount)).join("")}</div>
        ${state.activeRole === "admin" ? `<div class="student-finance"><h4>Фінанси</h4><div class="student-stats-grid finance-grid">${studentStatisticMetric("Поповнення", money(statistics.paid))}${studentStatisticMetric("Списано", money(statistics.spent))}${studentStatisticMetric(period.id === "all" ? "Поточний баланс" : "Різниця за період", money(statistics.balance))}</div></div>` : `<p class="student-finance-note">Фінансові показники доступні лише адміністратору.</p>`}
      </div>
    `;
  }

  function studentStatisticMetric(label, amount) {
    return `<div class="student-statistic-metric"><span>${escape(label)}</span><strong>${escape(String(amount))}</strong></div>`;
  }

  function studentStatisticsForPeriod(studentId, period) {
    const isInPeriod = (value) => {
      const date = localDate(value);
      return (!period.start || date >= period.start) && (!period.end || date <= period.end);
    };
    const lessons = state.data.lessons.filter((lesson) => isInPeriod(lesson.starts_at) && lessonStudents(lesson.id).some((item) => item.student_id === studentId));
    const ledger = state.activeRole === "admin"
      ? state.data.ledger.filter((row) => row.student_id === studentId && row.status === "confirmed" && isInPeriod(row.created_at))
      : [];
    return {
      total: lessons.length,
      planned: lessons.filter((lesson) => lesson.status === "planned").length,
      completed: lessons.filter((lesson) => lesson.status === "completed").length,
      cancelled: lessons.filter((lesson) => lesson.status === "cancelled").length,
      cancelledPaid: lessons.filter((lesson) => lesson.status === "cancelled_paid").length,
      paid: ledger.filter((row) => row.amount_uah > 0).reduce((sum, row) => sum + row.amount_uah, 0),
      spent: ledger.filter((row) => row.amount_uah < 0).reduce((sum, row) => sum + Math.abs(row.amount_uah), 0),
      balance: ledger.reduce((sum, row) => sum + row.amount_uah, 0)
    };
  }

  function metricCard(label, number, hint) {
    return `<article class="metric-card"><div class="metric-label">${escape(label)}</div><strong>${escape(String(number))}</strong><div class="meta">${escape(hint)}</div></article>`;
  }

  function empty(message) {
    return `<div class="empty-state">${escape(message)}</div>`;
  }

  function statusBadge(status) {
    const labels = { planned: "Заплановано", completed: "Проведено", cancelled: "Скасовано", cancelled_paid: "Скасовано з оплатою" };
    return `<span class="status status-${escapeAttr(status)}">${escape(labels[status] || status)}</span>`;
  }

  function lessonStatusOptions(selected) {
    return ["planned", "completed", "cancelled", "cancelled_paid"].map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${stripHtml(statusBadge(status))}</option>`).join("");
  }

  function submissionBadge(status) {
    return `<span class="submission-status submission-${escapeAttr(status)}">${escape(submissionLabel(status))}</span>`;
  }

  function submissionLabel(status) {
    return { not_started: "Не розпочато", submitted: "На перевірці", needs_revision: "На доопрацюванні", reviewed: "Перевірено" }[status] || status;
  }

  function roleTitle(role) {
    return { admin: "Адміністратор", teacher: "Викладач", student: "Учень" }[role] || role;
  }

  function membershipRoles(member = state.membership) {
    const roles = member?.roles;
    return Array.isArray(roles) ? roles : [];
  }

  function hasRole(role) {
    return membershipRoles().includes(role);
  }

  function preferredRole() {
    return ["admin", "teacher", "student"].find((role) => hasRole(role)) || "student";
  }

  function defaultViewForRole(role) {
    return navigationForRole(role)[0][0];
  }

  function modeTitle(role) {
    return { admin: "Адміністрування", teacher: "Викладання", student: "Навчання" }[role] || roleTitle(role);
  }

  function roleTitles(roles) {
    return roles.map(roleTitle);
  }

  function roleBadges(roles) {
    return roles.map((role) => `<span class="role-badge role-${escapeAttr(role)}">${escape(roleTitle(role))}</span>`).join("");
  }

  function roleCheckboxes(selectedRoles) {
    return `<div class="role-options">${["admin", "teacher", "student"].map((role) => `<label class="role-option"><input type="checkbox" name="roles" value="${role}" ${selectedRoles.includes(role) ? "checked" : ""} /><span>${escape(roleTitle(role))}</span></label>`).join("")}</div>`;
  }

  function renderModeSwitcher(activeRole) {
    const roles = membershipRoles();
    if (roles.length < 2) return "";
    return `<div class="mode-switch" aria-label="Режим роботи">${roles.map((role) => `<button type="button" class="mode-switch-item ${role === activeRole ? "active" : ""}" data-action="set-role" data-role="${escapeAttr(role)}">${escape(modeTitle(role))}</button>`).join("")}</div>`;
  }

  function ledgerLabel(kind) {
    return { payment: "Оплата", lesson_charge: "Списання за урок", refund: "Повернення", adjustment: "Коригування" }[kind] || kind;
  }

  function subjectName(id) {
    return state.data.subjects.find((item) => item.id === id)?.name || "Предмет";
  }

  function nameOf(id) {
    return state.data.profiles.find((profile) => profile.id === id)?.full_name || "Користувач";
  }

  function money(amount) {
    return `${new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 }).format(Number(amount) || 0)} грн`;
  }

  function signedMoney(amount) {
    return `${amount >= 0 ? "+" : "−"}${money(Math.abs(amount))}`;
  }

  function monthKey(value) {
    return isoDate(value).slice(0, 7);
  }

  function localDate(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return dateInTimezone(value, state.school?.timezone || "Europe/Kyiv");
  }

  function dateInTimezone(value, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
    const find = (type) => parts.find((part) => part.type === type)?.value;
    return `${find("year")}-${find("month")}-${find("day")}`;
  }

  function isoDate(value) {
    return localDate(value);
  }

  function dateTimeLocal(date, time) {
    return `${date}T${time}`;
  }

  function dateTimeInputValue(value) {
    const pad = (part) => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
  }

  function formatDateTime(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function monthTitle(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", month: "long", year: "numeric" }).format(value);
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function renderNotice() {
    if (!state.notice) return "";
    const notice = state.notice;
    state.notice = null;
    return `<div class="msg ${notice.type}">${escape(notice.message)}</div>`;
  }

  function success(message) { return { type: "success", message }; }
  function failure(message) { return { type: "error", message }; }

  function friendlyError(error) {
    const text = String(error?.message || error?.error_description || error || "Невідома помилка");
    if (error?.name === "NotAllowedError") return "Браузер не отримав доступ до мікрофона. Дозволь його у налаштуваннях сайту та спробуй ще раз.";
    if (error?.name === "NotFoundError") return "Мікрофон не знайдено. Під’єднай його або додай аудіофайл вручну.";
    if (text.includes("No active price")) return "Для цього учня немає активного тарифу. Адміністратор має вказати ціну уроку.";
    if (text.includes("Selected student is not assigned")) return "Цей учень не прикріплений до викладача.";
    if (text.includes("overlaps an existing lesson")) return "Цей час перетинається з іншим активним заняттям у твоєму календарі.";
    if (text.includes("Selected subject is unavailable")) return "Обраний предмет недоступний. Онови сторінку та вибери активний предмет.";
    if (text.includes("financial history cannot be deleted")) return "Урок уже має фінансову історію. Замість видалення зміни його статус на «Скасовано».";
    if (text.includes("Access denied")) return "Недостатньо прав для цієї дії.";
    if (text.includes("Email not confirmed")) return "Підтверди email, а потім увійди в кабінет.";
    if (text.includes("Administrator access required")) return "Для цієї дії потрібен активний доступ адміністратора.";
    if (text.includes("Invalid account data")) return "Перевір ім’я, email і пароль нового користувача.";
    if (text.includes("Password must contain")) return "Пароль має містити щонайменше 8 символів.";
    if (text.includes("Account has learning or financial history")) return "Цей акаунт уже має історію занять, матеріалів або оплат. Замість видалення призупини доступ, щоб зберегти дані.";
    if (text.includes("cannot delete their own account")) return "Власний акаунт не можна видалити з цього екрана.";
    if (text.includes("Account belongs to another school")) return "Цей акаунт має доступ до іншої школи, тому його не можна видалити з цього кабінету.";
    if (text.includes("Account owns another school")) return "Цей акаунт є власником іншої школи. Спершу передай там права власника.";
    if (text.includes("Select at least one role")) return "Вибери хоча б одну роль для користувача.";
    if (text.includes("At least one active administrator must remain")) return "У школі має залишитися щонайменше один активний адміністратор.";
    if (text.includes("Failed to send a request to the Edge Function")) return "Сервіс створення акаунтів ще не підключено. У Supabase відкрий Edge Functions, створи або задеплой функцію з назвою admin-users і повтори спробу.";
    return text;
  }

  function escape(value) {
    return String(value ?? "").replace(/[&<>'\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[character]));
  }

  function escapeAttr(value) {
    return escape(value);
  }

  function stripHtml(value) {
    return value.replace(/<[^>]*>/g, "");
  }
})();
